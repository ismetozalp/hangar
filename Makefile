PREFIX ?= /usr/share/cockpit
NAME = hangar
INSTALL_DIR = $(PREFIX)/$(NAME)
SYSCONF ?= /etc/$(NAME)
LIBEXEC ?= /usr/libexec/$(NAME)
# Must match CACHE_DIR in js/engine/restic.js and RESTIC_CACHE_DIR in
# libexec/hangar-run; tests/smoke.mjs asserts all of them agree.
CACHE_DIR ?= /var/cache/$(NAME)/restic
VERSION := $(shell cat VERSION)
TAG := v$(VERSION)
RELEASE_NOTES ?= Release $(VERSION)
export RELEASE_NOTES

# What ships. An explicit list, not a sweep of the working directory, so a
# development artifact can never reach a user by having been left lying around.
# COVERAGE.html and coverage/ are deliberately absent: they describe how the plugin
# was tested, which is a fact about this repository and no business of an
# installed copy.
FILES = manifest.json index.html README.md CHANGELOG.md VERSION Makefile css js html screenshots libexec

# Coverage is measured over the shipped browser sources only. tests/ is excluded
# because a test file's own coverage says nothing, and libexec/hangar-run is
# Python — driven as a subprocess by tests/integration, and invisible to node's
# instrumentation. See the note printed by `make coverage`.
COVERAGE_ARGS = --experimental-test-coverage \
	--test-coverage-include='js/**' --test-coverage-exclude='tests/**'
# Floors, not targets: a shade under what the suite achieves today, so a change
# that leaves new code untested fails the run instead of quietly moving the
# number down. Raise them when the real figures rise; never lower them to make a
# red run green.
COVERAGE_MIN = --test-coverage-lines=94 --test-coverage-branches=89 \
	--test-coverage-functions=90

.PHONY: all install uninstall zip publish clean help version test coverage release

all: help

help:
	@echo "hangar plugin — version $(VERSION)"
	@echo "  make install    Copy plugin to $(INSTALL_DIR) (use sudo)"
	@echo "  make uninstall  Remove plugin (use sudo)"
	@echo "  make test       Run unit tests with a coverage report"
	@echo "  make coverage   Coverage report plus coverage/lcov.info"
	@echo "  make zip        Produce hangar-$(VERSION).zip"
	@echo "  make publish    Publish zip as GitHub release $(TAG)"
	@echo "  make release    test + zip + commit COVERAGE.html + publish $(TAG)"
	@echo "  make version    Print current version"

version:
	@echo $(VERSION)

test:
	@node --test $(COVERAGE_ARGS) $(COVERAGE_MIN) tests/unit/*.test.js

# The same measurement, written down. coverage/lcov.info is the machine copy for
# editors and CI and is not committed; COVERAGE.html is the human one that is.
#
# Note the ordering: the report is only written if the run PASSED. A coverage
# figure recorded from a red suite describes code that does not work.
coverage:
	@mkdir -p coverage
	@node --test $(COVERAGE_ARGS) $(COVERAGE_MIN) \
		--test-reporter=spec --test-reporter-destination=stdout \
		--test-reporter=lcov --test-reporter-destination=coverage/lcov.info \
		tests/unit/*.test.js
	@node tests/coverage.mjs
	@echo ""
	@echo "Not counted: libexec/hangar-run (Python, driven by tests/integration),"
	@echo "markup and styles, and the tests themselves. See COVERAGE.html."

# Cut a release: prove it, build it, record what was proven, ship it.
#
# The order is the argument. Tests first, so nothing is built from a red tree.
# Then the archive, so what ships is what was tested. Then the coverage report,
# committed, so the repository carries a record of what the release was actually
# measured at rather than a claim in a message. Then publish.
#
# Deliberately does NOT bump the version or create the tag. Deciding that a
# change is 1.0.8 is a judgement, and a judgement does not belong in a recipe.
release: test zip coverage
	@if [ -n "$$(git status --porcelain -- COVERAGE.html)" ]; then \
	  echo "Committing the coverage report for $(VERSION)"; \
	  git add COVERAGE.html; \
	  git commit -q -m "Record coverage for $(VERSION)" \
	    -m "Written by \`make coverage\` from the run that gated this release."; \
	  git push -q origin HEAD; \
	else \
	  echo "Coverage report unchanged since the last commit"; \
	fi
	@$(MAKE) --no-print-directory publish
	@echo ""
	@# gh creates $(TAG) at HEAD when it does not exist, which puts the tag, the
	@# archive and the coverage report on the same tree. When the tag already
	@# exists it is left alone — moving a published tag is the user's call, not a
	@# recipe's, because anyone who already fetched it would silently diverge.
	@if git rev-parse -q --verify "refs/tags/$(TAG)" >/dev/null && \
	   [ "$$(git rev-parse refs/tags/$(TAG)^{commit})" != "$$(git rev-parse HEAD)" ]; then \
	  echo "Note: $(TAG) points at $$(git rev-parse --short refs/tags/$(TAG)^{commit}), not at HEAD"; \
	  echo "      ($$(git rev-parse --short HEAD)), so the tagged tree predates the coverage report."; \
	  echo "      To line them up:  git tag -f -a $(TAG) && git push -f origin $(TAG)"; \
	fi
	@echo "Released $(TAG)"

install:
	@if [ "$$(id -u)" != "0" ]; then echo "install requires root (use sudo)"; exit 1; fi
	@if [ -d $(INSTALL_DIR) ]; then echo "Removing previous install"; rm -rf $(INSTALL_DIR); fi
	install -d $(INSTALL_DIR)
	@# Copy only FILES that exist — the plugin is built incrementally, so dirs
	@# like html/ may not exist in early phases; a missing entry must not abort.
	@for f in $(FILES); do if [ -e "$$f" ]; then cp -r "$$f" $(INSTALL_DIR)/; fi; done
	@# Python compiles hangar-run beside itself when the tests import it. It is
	@# build output for one interpreter version and has no business shipping.
	@find $(INSTALL_DIR) -name __pycache__ -type d -prune -exec rm -rf {} +
	@rm -rf $(INSTALL_DIR)/COVERAGE.html $(INSTALL_DIR)/coverage
	install -d $(LIBEXEC)
	@if [ -f libexec/hangar-run ]; then install -m 0755 libexec/hangar-run $(LIBEXEC)/hangar-run; fi
	install -d -m 0755 $(SYSCONF)
	install -d -m 0700 $(SYSCONF)/repos
	# restic finds its cache from $$XDG_CACHE_HOME or $$HOME, and the systemd units
	# that run backups and the Logbook mount have neither — so hangar passes
	# --cache-dir explicitly and the directory is created here rather than left to
	# whichever process happens to run restic first.
	install -d -m 0700 $(CACHE_DIR)
	install -d -m 0755 $(SYSCONF)/jobs
	printf '%s\n' "$(VERSION)" > $(SYSCONF)/installed-version
	@echo "Installed hangar $(VERSION) to $(INSTALL_DIR)"
	@echo "Restart Cockpit with: systemctl try-restart cockpit"

uninstall:
	@if [ "$$(id -u)" != "0" ]; then echo "uninstall requires root (use sudo)"; exit 1; fi
	rm -rf $(INSTALL_DIR)
	rm -rf $(CACHE_DIR)
	rm -rf $(LIBEXEC)
	@echo "Removed $(INSTALL_DIR) and $(LIBEXEC)"
	@echo "Configuration in $(SYSCONF) was left in place — remove it manually if desired."

zip:
	@tmp=$$(mktemp -d); \
	mkdir "$$tmp/hangar"; \
	for f in $(FILES); do [ -e "$$f" ] && cp -r "$$f" "$$tmp/hangar/"; done; \
	find "$$tmp/hangar" -name __pycache__ -type d -prune -exec rm -rf {} +; \
	rm -rf "$$tmp/hangar/COVERAGE.html" "$$tmp/hangar/coverage"; \
	if [ -e "$$tmp/hangar/COVERAGE.html" ] || [ -e "$$tmp/hangar/coverage" ]; then \
	  echo "refusing to ship the coverage report"; exit 1; fi; \
	(cd "$$tmp" && zip -rq "hangar-$(VERSION).zip" hangar); \
	mv "$$tmp/hangar-$(VERSION).zip" .; \
	rm -rf "$$tmp"; \
	echo "Wrote hangar-$(VERSION).zip"

publish: zip
	@command -v gh >/dev/null 2>&1 || { echo "gh CLI not found"; exit 1; }
	@gh auth status >/dev/null 2>&1 || { echo "gh not authenticated — run: gh auth login"; exit 1; }
	@notes="$$(mktemp)"; trap 'rm -f "$$notes"' EXIT; \
	printf '%s\n' "$$RELEASE_NOTES" > "$$notes"; \
	if gh release view "$(TAG)" >/dev/null 2>&1; then \
	  gh release upload "$(TAG)" "hangar-$(VERSION).zip" --clobber; \
	  gh release edit "$(TAG)" --notes-file "$$notes"; \
	else \
	  gh release create "$(TAG)" "hangar-$(VERSION).zip" --title "hangar $(VERSION)" --notes-file "$$notes"; \
	fi
	@rm -f "hangar-$(VERSION).zip"
	@echo "Published $(TAG)"

clean:
	rm -f hangar-*.zip
