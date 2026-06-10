# Dashboard — Open AI-RAN Testbed

The web UI of the testbed: deploy and watch RAN stacks, build and simulate Sionna RT scenes, train AI-RAN models and work with the LLM agents.
It is a front end over the repository's `make` targets, so every button has a shell equivalent and both share the same settings.

```
dashboard/
├── backend/app/      FastAPI: runs make jobs, drives Sionna, mirrors remote runs, serves the built UI
├── backend/tests/    unit tests (no GPU or RAN needed)
├── frontend/src/     React + TypeScript + Vite
│   ├── screens/      one file per page
│   ├── components/   sidebar, docks, job bar, shared UI
│   └── lib/          API client, auth, types
├── sionna-map/       MapLibre scene editor and the Sionna RT scene builder (see its README)
└── run.sh            serve, develop, build, test
```

## Run

```bash
make dashboard          # from the repository root, same as ./run.sh serve
```

The first run creates the backend venv and installs npm packages, then builds the frontend and serves the whole app from one port: `http://<server-ip>:8000`.

| Command | Purpose |
|---|---|
| `./run.sh serve` | Build the frontend and serve everything on one port |
| `./run.sh dev` | Hot reload: backend on `:8000`, open the Vite server on `:5173` (it proxies `/api` and `/ws`) |
| `./run.sh build` | Build `frontend/dist/` only |
| `./run.sh test` | Backend unit tests and the map module tests |
| `./run.sh audit` | End-to-end checks against a live backend |

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `8000` | Listening port |
| `HOST` | `0.0.0.0` | Bind address; `127.0.0.1` keeps it on this machine |
| `TOSSI_PASSWORD` | generated | Password of the first `admin` account |
| `TOSSI_SIONNA_PYTHON` | `~/sionna-rt-env/bin/python3` | Python with Sionna RT installed |
| `TOSSI_OPEN` | off | `1` disables login; loopback, single-user machines only |
| `TOSSI_BUILD_TIMEOUT`, `TOSSI_TRACE_TIMEOUT`, `TOSSI_COVERAGE_TIMEOUT` | `600`, `900`, `1800` | Sionna job limits in seconds |
| `TOSSI_SITES_DIR` | `backend/work/_sites` | Measured site models |
| `TOSSI_AUTO_RECOVER` | off | `1` restarts a RAN whose tunnel has died |

## Sign-in and roles

The backend starts RAN processes with `sudo`, so anyone who can sign in can run privileged commands on the server.
When `HOST` is not loopback, the well-known default password is refused; without `TOSSI_PASSWORD` a random one is generated into `var/dashboard/password` (mode 600) and printed at start-up.

Accounts live in `var/dashboard/users.json` (PBKDF2 hashes). Roles: `admin` (everything, including people), `operator` (everything except people) and `viewer` (read-only; the API answers `403` to any write).
Sessions are held in memory, so a backend restart signs everyone out. A job running at the time shows as **Orphaned**.

## Pages

| Page | What it does |
|---|---|
| **Dashboard** | Agent activity, the latest scene, machine health, models and data, recent runs |
| **Deployments** | Check / Build / Deploy / Run all / Train / Stop, each a background `make` job with a live log; per-stack configs saved to `var/overrides/<stack>.env`; components, results and history |
| **Topology** | Each running stack drawn from its conf, with interface labels and live DL/UL throughput, CQI, MCS, BLER and SNR |
| **Agents** | Deploy, ML and General LLM agents with approvals, tool list and LLM settings |
| **Servers** | Register servers over SSH, probe their capabilities, open a terminal |
| **Scenes** · **Scenario Builder** | Sionna scene library and editor: area, gNBs, towers, UEs, routes, build, ray trace, coverage, channel export, scene bundles |
| **Simulation** | **Ray Trace** runs `sionna-rt-ocudu` on a server it has come up on and mirrors it live; **Handover** runs two cells over Xn |
| **Runs** · **Data Lake** | Stack runs and simulation recordings; logs and CSV datasets per run |
| **AI Studio** | Datasets, models and benchmarks, with the ML agent |
| **Admin** | People, roles and passwords |

Only one `make` job runs at a time; the job bar on every page shows it, with **View log** and **Cancel**.

## API

All routes need a bearer token from `POST /api/login` (`{"username", "password"}`), except `/api/health` and the `/api/terrain` tiles.

| Prefix | Area |
|---|---|
| `/api/deploy` | Stacks, jobs, configs, component logs, results, topology |
| `/api/hosts` | Servers, capability probe, placement, terminal |
| `/api/map` | Scenes, build, trace, coverage, live channel, models, site models |
| `/api/channel` · `/api/provenance` | Channel export, scene bundles, sealed provenance |
| `/api/ran` · `/api/sim` | RAN status and logs for the simulation; platform-run Sionna stack |
| `/api/recordings` | Simulation recordings, reports, A3 handover analysis |
| `/api/lake` · `/api/studio` | Data Lake, datasets, models, benchmarks |
| `/api/agents` | Agent chats, approvals, LLM settings, activity |
| `/api/users` | Accounts and roles |
| `/api/terrain` | Elevation tiles for the 3D map |

## Data

| Path | Contents |
|---|---|
| `var/dashboard/` | `users.json`, `hosts.json`, `llm.json`, `jobs/`, `agents/`, `sim/`, `remote_mirror/` |
| `backend/work/<scene_id>/` | Sionna scenes (`package.json`, `meta.json`, `scene/scene.xml`, `coverage.json`) |
| `backend/work/_runs/` | Simulation recordings |
| `backend/work/_sites/<id>/` | Measured site models |

## Requirements

- Node 18+ and npm, Python 3.10+
- A Sionna RT environment for the Scenario Builder and Simulation (optional; the rest runs without it):
  `~/sionna-rt-env/bin/python3 -m pip install -r sionna-map/scene_builder/requirements.txt`
