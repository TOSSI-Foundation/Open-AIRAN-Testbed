SHELL := /bin/bash
.PHONY: dashboard list check check-strict cmdline prepare fetch install build deploy all train status attach logs stop killall clean distclean help

export STACK
export DRYRUN
export VERBOSE
export WORKSPACE
export IF
export PTP_IF
export PTP_CFG
export PTP_PROFILE
export USRP_ADDR
export UHD_COMMIT
export EXTRA_CMAKE_OPTS

help:
	@echo "make list                    stacks available"
	@echo "make check   STACK=<s>       system requirements only (--fix: FIX=1)"
	@echo "make cmdline STACK=<s>       kernel cmdline diff (APPLY=1 writes+update-grub)"
	@echo "make prepare STACK=<s>       deps + drivers + host networking"
	@echo "make install STACK=<s>       prepare + fetch sources"
	@echo "make build   STACK=<s>       build every component (ONLY=<c> for one)"
	@echo "make deploy  STACK=<s>       configure + start in order, health-gated"
	@echo "make all     STACK=<s>       install -> build -> deploy"
	@echo "make train   STACK=<s>       train the ML model on the logged datasets"
	@echo "make status | attach | logs C=<c> | stop | killall | restart C=<c> | clean"
	@echo "  attach: all components run as windows of one tmux session per stack"
	@echo ""
	@echo "IF=<iface> sets the PTP/fronthaul interface. USRP_ADDR=<ip> for RF stacks."
	@echo "DRYRUN=1 prints every command without running it."
	@echo ""
	@$(MAKE) --no-print-directory list

dashboard:
	@dashboard/run.sh serve

list:
	@echo "stacks:"
	@bash -c '. automation/lib/includes.sh; list_stacks'

check:
	@automation/verbs/check_system.sh $(if $(FIX),--fix,)

check-strict:
	@automation/verbs/check_system.sh --strict $(if $(FIX),--fix,)

cmdline:
	@automation/verbs/cmdline.sh $(if $(APPLY),--apply,)

prepare: check
	@automation/verbs/cmdline.sh --check || echo "   (run: make cmdline STACK=$(STACK) APPLY=1, then reboot)"
	@automation/verbs/install_deps.sh
	@automation/verbs/install_drivers.sh
	@automation/verbs/setup_net_ifs.sh

fetch:
	@automation/verbs/fetch.sh $(if $(OFFLINE),--offline,)

install: prepare
	@automation/verbs/fetch.sh $(if $(OFFLINE),--offline,)
	@automation/verbs/install_deps.sh --components

build: check-strict
	@automation/verbs/fetch.sh $(if $(OFFLINE),--offline,)
	@automation/verbs/build.sh $(if $(ONLY),--only=$(ONLY),)

deploy: check-strict
	@automation/verbs/deploy.sh

all: install build deploy

status:
	@automation/verbs/run.sh status
train:
	@automation/verbs/train.sh
attach:
	@automation/verbs/run.sh attach
logs:
	@automation/verbs/run.sh logs $(if $(F),-f,) $(C)
stop:
	@automation/verbs/run.sh stop
killall:
	@automation/verbs/run.sh killall
restart:
	@automation/verbs/run.sh restart $(C)

clean:
	@rm -rf var/run/$(STACK) var/stamps/$(STACK)
	@echo "cleaned runtime state for $(STACK)"
distclean: clean
	@rm -rf var/stamps
	@echo "all stamps dropped; sources in $${WORKSPACE:-~/tossi-ran} left alone"
