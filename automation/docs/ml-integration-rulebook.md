# Rulebook: integrating an ML model into OCUDU

For the ML agent (and the engineers it works with). It is derived from the four ML
features already in TOSSI OCUDU-RAN — `bsr_ml` (branch `dev`), `ml_mcs`
(`ml_mcs_model`), `csi_ml` (`ml_csi`) and `slice_ml` (`slice_ml`) — and is written
for any testbed: nothing here assumes a particular server, CPU layout, NIC, radio or
core. Look those up on the host you are working on (`host_info`, the stack's
configs, `check`) instead of reusing values from another site.

Paths are relative to the OCUDU tree unless they start with `automation/`.

---

## 1. The anatomy every OCUDU ML feature has

All four features follow one template. A new one should too, so operators, the
dashboard and this automation can treat it the same way.

| Part | Where it lives | Reference |
|---|---|---|
| YAML block `<f>:` with `dataset_logging`, `inference` (and optionally `actuation`) | `apps/units/flexible_o_du/o_du_high/du_high/du_high_config.h` (struct `du_high_unit_<f>_config`) | all four |
| CLI11 schema | `du_high_config_cli11_schema.cpp` (`configure_cli11_<f>_args`, registered as subcommand `<f>`) | all four |
| Translation to the scheduler | `du_high_config_translators.cpp` → `<f>_expert_config` in `include/ocudu/scheduler/config/scheduler_expert_config.h`, member of `scheduler_ue_expert_config` | all four |
| Dataset logger | `lib/scheduler/logging/<f>_dataset_logger.{h,cpp}`, added to the `scheduler_logger` target | all four |
| Predictor (header-only) | `lib/scheduler/support/<f>_predictor.h`: model struct + `valid()`, Meyers-singleton `predictor` with `configure()/predict()/reload()` | all four |
| Compiled-in seed model | `lib/scheduler/support/<f>_model.inc` (constexpr arrays) | all four |
| Runtime model file | JSON text with `"format"`, `"version"`, the weights and a `meta` block, loaded from `inference.model_path`, hot-reloaded on mtime change | all four |
| Scheduler hook | the code path that owns the decision (see §3) | per feature |
| Actuation (optional) | the path that changes UE/cell configuration | `bsr_ml`, `slice_ml` |
| Training script | `ml/training/train_<f>.py`, exports `.inc` and `.model` from the same run | all four |
| Offline analysis / parity | `ml/analysis/` | `mcs`, `csi`, `slice` |

How each one decides:

| Feature | Decision | Model | Called from | Cadence | Applied by |
|---|---|---|---|---|---|
| `bsr_ml` | periodic BSR timer per UE | RBF features + linear SVR | `ue_event_manager` BSR path → `bsr_ml_dataset::classify_bsr_trigger` | per regular BSR (after 30 of them) | DU manager → F1AP UE Context Modification Required → RRC reconfig, with hysteresis + 10 s dwell |
| `ml_mcs` | UL MCS per grant | gradient-boosted trees (P(success)) | `ue_link_adaptation_controller::calculate_ul_mcs` | per new-TX UL grant | directly (MCS search inside `ul_mcs_lims`, OLLA as fallback) |
| `csi_ml` | next effective CQI (DL MCS input) | Wiener AR or small GRU | `ue_cell::handle_csi_report` → `calculate_dl_mcs` | per CSI report | directly when `apply_to_mcs`, clamped to [1,15] |
| `slice_ml` | slice PRB ratios (eMBB/URLLC) | LSTM actor, 19-action menu | metrics consumer `slice_ml_controller::handle_report` (metrics executor, off the slot path) | per DU metrics report (~1 s) | `du_configurator::handle_sync_operator_config` → RRM policy, with safety gates + post-check |

---

## 2. Lifecycle: collect → train → shadow → closed loop

Never skip a stage, and never move to the next without the evidence named here.

1. **Collect.** `dataset_logging.enabled: true`, inference and actuation off. The
   baseline (OLLA, the static timer, the configured slice ratios) drives the cell.
   Collect across the conditions the model must handle (load, mobility, channel) and
   tag each campaign with `scenario`. Evidence: CSVs in the data lake with enough
   rows and enough variety (§5).
2. **Train.** Offline, on data collected with inference **off** — data logged while
   the model was in control is biased by the model (a feedback loop; `ml_mcs` writes
   its own decision into `olla_mcs` once inference is on). Evidence: the held-out
   metric beats the baseline the feature replaces (MAE vs zero-order-hold, AUC/Brier
   vs incumbent, accuracy vs majority class). If it does not, stop.
3. **Shadow.** `inference.enabled: true`, apply/actuation off. The model runs on live
   traffic and its output is logged next to the baseline's decision. Evidence:
   predictions are sane (not collapsed to one value), cost is affordable on the
   thread it runs on, and offline replay of the shadow CSV shows the gain.
4. **Closed loop.** Apply/actuation on, with every guard from §7 in place, one cell
   or one UE class first. Evidence: the target KPI improves and no guard KPI (BLER,
   drops, RLFs, latency) regresses; the kill switch has been tested.

In this automation: `ML_MODE=collect|shadow|closed-loop` picks
`automation/configs/ai-ran/<f>_collect.yml` plus `<f>_<mode>.yml`; `make train STACK=<s>`
(or `train_model` with chosen CSVs) writes the stack's `ML_MODEL`. Each step that changes
the testbed waits for the operator's approval.

---

## 3. Step by step: integrating a new model

### Step 0 — know where you are
- Which OCUDU tree does the stack use (`stack_config` → `OCUDU_SRC_DIR`, or a local
  `OCUDU_TREE`)? Does it build as-is? Build it before touching anything, so later
  failures are yours.
- What does the host offer (`host_info`): cores, isolation, GPU or not. Inference in
  the DU is CPU-only C++; do not plan on a GPU in the slot path.

### Step 1 — define the decision
Write down, before any code:
- **Decision**: what value changes (an MCS, a timer, a ratio…), its legal range, and
  the baseline that makes it today.
- **Owner**: the scheduler/DU code that makes that decision now. Hook there, not
  somewhere that has to be kept in sync with it.
- **Cadence and thread**: per slot/grant/CSI/BSR event (scheduler thread, real time)
  or per metrics period (metrics executor, off the slot path). Prefer the slowest
  cadence that still captures the effect; use the metrics path for anything that
  reconfigures cells or UEs.
- **Features**: only values available at decision time on that thread. List each
  with units and source.
- **Label**: what "right" means, observable later in a log (CRC success, next CQI,
  inter-arrival, a utility).

### Step 2 — configuration
- Add `du_high_unit_<f>_config` with nested `dataset_logging`, `inference`, and
  `actuation` (or an `apply` flag) — **everything off by default**.
- CLI11: `configure_cli11_<f>_args`, `capture_default_str()`, range checks
  (`CLI::Range`, `CLI::IsMember`), register subcommand `<f>`.
- Translator: copy into `<f>_expert_config` (or `du_cell_config` if the DU manager
  acts on it, like `bsr_ml_actuation_enabled`). Translate *every* field the runtime
  needs — `slice_ml` had to rebuild plmn/sst/sd in a second place because the
  translator skipped them.
- **Add a validator** (none of the four has one): model file readable if inference
  is on, ranges consistent, dependent features enabled (see Step 6), slice members
  matching `cell_cfg.slicing`. Fail at startup, not silently at run time.
- Add the block to the YAML writer so `--dump-config` shows it.
- OCUDU rejects unknown YAML keys: every key a Python helper reads from the same
  file must exist in the schema, or keep it in a separate file.

### Step 3 — dataset logger
- `lib/scheduler/logging/<f>_dataset_logger.{h,cpp}`, in `scheduler_logger`.
- File `<output_dir>/<f>_dataset_<YYYYmmdd_HHMMSS>.csv`; create the directory; one
  header row; `nan` for missing values.
- Columns: keys (slot, sfn, rnti/ue_index or pci/slice), every **feature** exactly as
  the predictor will see it, the **baseline decision**, the **decision actually
  applied**, the **model's prediction** (filled in shadow), the **label**, and
  `scenario`. `slice_ml` does not log the applied action and the trainer has to
  reconstruct it — log it.
- Feature parity: the logger and the predictor must compute features with the same
  code (a shared function), or training and inference drift apart.
- Do not make inference depend on logging. In `bsr_ml` and `slice_ml` the inference
  path only runs when `dataset_logging.enabled` is true (state is built inside the
  logger); new features keep that state in the feature's own object.
- Performance: today's loggers format and `fputs` under a mutex on the scheduler
  thread. New ones should hand rows to a lock-free queue drained by a non-RT thread,
  or at least batch writes, and never block the slot.

### Step 4 — training script
- `ml/training/train_<f>.py [csv ...] --inc-out <f>_model.inc --model-out <f>.model`.
  Accept explicit CSVs (the data lake hands it exact files) and default to the
  feature's glob.
- Split **by time or by run** (never shuffle rows across a split); de-duplicate; hold
  out whole runs when rows are correlated.
- A baseline's error is computed like the model's: `mean(|baseline_prediction -
  target|)` on **the same test rows**, in the target's units. The mean of the
  baseline's predictions is not an error; a baseline whose "MAE" equals the target's
  mean is predicting zeros (or is not an error at all). Use a fixed seed and print
  the number of runs and rows in each split.
- Export only a model the C++ predictor can evaluate exactly: a tree ensemble's
  feature importances are not linear weights.
- Print the held-out metric **next to the baseline**; refuse (non-zero exit) if the
  data cannot support a model: too few rows/windows, one class/action only,
  collapsed predictions. `slice_ml`'s shipped model only matches its majority
  baseline — that is a model not to promote.
- Export `.inc` and `.model` from the same run. The `.model` carries `format`,
  `version`, the feature list/count, normalisation constants, weights, and `meta`
  (sources, rows, metrics, git commit). Flatten arrays row-major and say so.
- Keep feature names/order in one shared module (`ml/<f>_config.py`, like
  `ml/ml_config.py`) used by the trainer and analysis scripts.

### Step 5 — predictor
- Header `lib/scheduler/support/<f>_predictor.h`:
  - `model` struct with `valid()` (array sizes) and a pure `predict(features)`;
  - seed built from the `.inc` at construction;
  - `configure(cfg)` loads `model_path` if set and valid, else keeps the seed —
    **called once per process**, not per UE (all four currently re-run it on every
    UE creation, re-reading the file from the scheduler);
  - hot reload: poll the file's mtime on a time basis (not "every N calls"), parse
    **off the slot path** if you can, publish with an atomic `shared_ptr` swap,
    keep the old model if the new one is invalid, log one line per swap;
  - **check `format`, `version` and feature count** — today's loaders ignore
    `format`/`version`; a model for another feature must be rejected, not run.
- Evaluate with fixed-size buffers (no per-call `std::vector`), in `float` or
  `double` as trained, with the exact ops of the training framework (gate order,
  bias sums, normalisation). Bound the work: count multiply-adds per decision and
  per slot at peak UEs.
- Clamp the output to the decision's legal range and return "no prediction" when
  inputs are incomplete (window not full, CQI 0, slice missing).

### Step 6 — wire it into the decision
- Configure the predictor and logger once (constructor of a per-cell object, or a
  guarded call-once), not from per-UE constructors.
- Shadow: compute and log the prediction, leave the baseline in charge.
- Apply only behind the flag, and only through the code that owns the decision.
- Fallback to the baseline whenever the model is missing, invalid, disabled, or the
  kill switch is set (`ml_mcs` checks a revert-flag file — keep that idea, check it
  on a timer).
- Actuation that reconfigures UEs or cells runs off the slot path, with hysteresis,
  a minimum dwell between changes, safety gates on the value (ranges, sums, floors)
  and a check that the change took effect (`slice_ml`'s `verify_last_actuation`).
- Multi-cell: decide per cell and apply to that cell only (`slice_ml` broadcasts to
  every cell from each per-PCI controller — do not copy that).
- Initial state: the controller's assumed starting action must equal what the cell
  boots with (`slice_ml`'s `default_action_idx` vs `cell_cfg.slicing`).

### Step 7 — build and test
- Add new `.cpp` files to the right CMake target (`scheduler_logger`, `ocudu_sched`,
  `du_high` or `du_manager/procedures`); no new third-party dependency in the DU.
- Commit every header you include (`slice_ml` does not build because
  `lib/scheduler/support/csi_ml_window.h` was never committed there; `ml_csi` added it later). Build from a clean
  tree before calling it done; build with warnings as errors if the project does.
- Tests that did not exist for the four features and should for new ones:
  - a **parity test**: the C++ predictor and the Python model on the same inputs agree
    within a tolerance (`ml/analysis/verify_slice_ml_forward` shows how);
  - loader tests: valid file, truncated file, wrong `format`, wrong feature count;
  - a unit test of the hook with the feature off (behaviour identical to baseline).
- Run the existing scheduler unit tests; signature changes ripple into them.

### Step 8 — put it into this automation
- Stack conf: `automation/stacks/ai-ran-<f>.conf` sourcing `ai-ran-common.sh`, with
  `OCUDU_BRANCH`, `ML_OVERLAY=<f>_collect.yml`, `ML_MODEL` (where the trainer writes
  the runtime model, relative to the OCUDU tree) and `ML_TRAIN` (the training command).
- Overlays: `automation/configs/ai-ran/<f>_collect.yml`, `<f>_shadow.yml`,
  `<f>_closed-loop.yml` (omit a mode the feature does not have, and declare the
  stack's own `# knob: ML_MODE …` line).
- Dashboard: add the feature to `dashboard/backend/app/ml_info.py` `FEATURES`
  (label, algorithm, default model path, dataset glob) so the gNB card, Data Lake and
  AI Studio pick it up.
- Then run the lifecycle (§2) through the tools: collect → `train_model` on chosen
  CSVs → `ML_MODE=shadow` + deploy → compare → closed loop.

---

## 4. Bringing your own model

A model uploaded in AI Studio can be used directly only if it is in the runtime
format of that feature's predictor (`"format"` above, same feature list and shapes).
Otherwise:
1. read the predictor header to learn the expected format;
2. if the architecture matches (same features, same model family), convert the
   weights into that JSON — never edit the C++ to fit one file;
3. if it does not (an ONNX/PyTorch network of another shape), it is a new predictor:
   follow Step 5–7 (with a parity test), keeping the feature's config, logger and
   lifecycle unchanged.
Install a converted model by writing it where the stack's DU loads it (the stack's
`ML_MODEL`); the DU hot-reloads it. Start in shadow.

---

## 5. Data rules

- Enough data: tens of thousands of decisions for per-grant models, hundreds of
  windows per UE for windowed ones, several separate runs for policies.
- Variety: more than one load, channel and mobility condition; more than one action
  for policies; tag scenarios.
- Collected with the model **off**. Keep shadow and closed-loop data separate, and
  never mix simulated (ZMQ/rfsim) and over-the-air data without a scenario tag.
- Check the CSV before training: columns present, no constant columns, labels not
  all one value, timestamps monotonic per file.

---

## 6. Real-time rules

The scheduler runs every slot (0.5 ms at 30 kHz). On that thread:
- no file I/O, no `stat()`/`fopen` per decision, no blocking locks, no heap
  allocation per decision, no logging per decision above debug;
- bound the cost: multiply-adds × decisions per slot at peak load must leave the
  slot budget intact — measure with the DU's latency metrics in shadow;
- prefer moving inference to the event that already happens less often (CSI report,
  BSR, metrics period) over running it per grant.
Existing features break several of these (synchronous CSV writes under a mutex,
per-UE `configure()` with file reads, model parsing on reload, per-call vectors).
Do not copy those parts; fix them when you touch them.

---

## 7. Safety rules

- Off by default; shadow before closed loop; the baseline always available.
- Output clamped to the legal range of the decision.
- A kill switch that reverts to the baseline without a restart.
- Hysteresis and minimum dwell for anything that reconfigures UEs or cells.
- Verify actuation took effect; log and back off if it did not.
- Every change on the testbed (settings, files, builds, deploys, training) goes
  through the operator's approval; propose, explain in one line, wait.
- Keep the previous model (`.lastgood` / backup) so a bad one can be rolled back.

---

## 8. Known issues in the four reference features

Read these before reusing their code.

- `slice_ml` does not build: `lib/scheduler/ue_context/ue_channel_state_manager.h`
  includes `../support/csi_ml_window.h`, which was never committed on that branch.
  `ml_csi` has it (and `train_export_csi_wiener.py`); copy it from there.
- `bsr_ml`: inference and actuation run only with `dataset_logging.enabled`; the
  actuation does not update the scheduler's own copy of the timer; only the first
  cell's BSR config is used.
- `ml_mcs`: no shadow mode (inference on = in control); with inference on, the logged
  `olla_mcs` is the ML decision; the predictor is called at three sites per grant.
- `csi_ml`: window size is hard-coded to 4 in C++ and Python; inference runs twice per
  CSI report; the example YAML enables `apply_to_mcs` despite being a collect config.
- `slice_ml`: needs scheduler or MAC metrics enabled or the controller is never
  created; observations need dataset logging (SSR); the seed always picks action 12;
  `default_action_idx` must match the boot slice ratios; actuation is broadcast to
  all cells; the shipped model does not beat its majority baseline.
- All four: no config validator, no unit tests, loggers and model reloads on the
  scheduler thread, `configure()` per UE.

---

## 9. Checklists

**Before calling an integration done**
- [ ] Decision, owner, cadence, features and label written down
- [ ] Config block off by default, schema + translator + validator + YAML writer
- [ ] Logger with features, baseline, applied decision, prediction, label, scenario
- [ ] Trainer with time/run split, baseline comparison, refusal on bad data, `.inc` + `.model`
- [ ] Predictor: format/version/feature checks, seed fallback, time-based hot reload, bounded cost
- [ ] Hook: shadow path, flag-gated apply, baseline fallback, kill switch
- [ ] Clean build of every target, parity + loader tests, existing tests pass
- [ ] Stack conf, overlays and `ml_info.py` entry in this automation

**Before closed loop on a testbed**
- [ ] Trained on model-off data, beats baseline on held-out runs
- [ ] Shadow run on this testbed reviewed (predictions, cost, would-be decisions)
- [ ] Guard KPIs and their thresholds chosen; kill switch tested
- [ ] Previous model kept; operator approved the switch
