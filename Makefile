# Cutaway — full chain: generate -> validate -> export -> screenshot
PY      := PYTHONPATH=. .venv/bin/python
PARAMS  := $(shell grep -l "^generator:" data/*.yaml)
# which components `make screenshots` captures (comma list of ids, or "all")
COMPONENTS ?= all

.PHONY: all setup generate export test preview viewer-install dev viewer-build typecheck screenshots clean

all: export test preview typecheck screenshots

setup: .venv/.ok viewer-install

.venv/.ok: pyproject.toml
	python3 -m venv .venv
	.venv/bin/pip install -q -e .
	touch $@

# generate + validate (B-rep, overlap, mesh) + export GLB/JSON/STEP
generate export:
	$(PY) -m geometry.build $(PARAMS)

test:
	$(PY) -m pytest -q -p no:warnings

preview:
	$(PY) -m geometry.preview $(PARAMS)

viewer-install:
	cd viewer && npm install && npx playwright install chromium

dev:
	cd viewer && npm run dev

viewer-build:
	cd viewer && npm run build

typecheck:
	cd viewer && npx tsc --noEmit

# every metadata preset x variant x component + interaction scenarios, then contact sheets
screenshots:
	cd viewer && COMPONENTS=$(COMPONENTS) npx playwright test
	$(PY) viewer/tests/contact_sheet.py

clean:
	rm -rf build viewer/dist viewer/test-results
