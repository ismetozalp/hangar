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

FILES = manifest.json index.html README.md CHANGELOG.md VERSION Makefile css js html screenshots libexec

.PHONY: all install uninstall zip publish clean help version test

all: help

help:
	@echo "hangar plugin — version $(VERSION)"
	@echo "  make install    Copy plugin to $(INSTALL_DIR) (use sudo)"
	@echo "  make uninstall  Remove plugin (use sudo)"
	@echo "  make test       Run unit tests"
	@echo "  make zip        Produce hangar-$(VERSION).zip"
	@echo "  make publish    Publish zip as GitHub release $(TAG)"
	@echo "  make version    Print current version"

version:
	@echo $(VERSION)

test:
	@node --test tests/unit/*.test.js

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
