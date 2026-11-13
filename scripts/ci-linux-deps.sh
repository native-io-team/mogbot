#!/usr/bin/env bash
# Installs the Linux packages Tauri needs on a GitHub runner, without hanging.
# The runners' default mirror (azure.archive.ubuntu.com through apt-mirrors.txt)
# has stopped resolving for whole afternoons; apt then retries every package
# for an hour. Here apt talks to the main Ubuntu archive directly, with short
# timeouts, and the whole install is retried a few times.
#
#   scripts/ci-linux-deps.sh [extra packages...]
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

if [ -f /etc/apt/apt-mirrors.txt ]; then
  case "$(dpkg --print-architecture)" in
    amd64 | i386) archive=http://archive.ubuntu.com/ubuntu/ ;;
    *) archive=http://ports.ubuntu.com/ubuntu-ports/ ;;
  esac
  echo "$archive" | sudo tee /etc/apt/apt-mirrors.txt >/dev/null
fi

opts=(-o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20)
packages=(
  libgtk-3-dev
  libwebkit2gtk-4.1-dev
  libayatana-appindicator3-dev
  librsvg2-dev
  libssl-dev
  libsoup-3.0-dev
  libjavascriptcoregtk-4.1-dev
  # Dictation: the microphone (cpal → ALSA) and whisper.cpp's build.
  libasound2-dev
  cmake
  "$@"
)

for attempt in 1 2 3; do
  if sudo apt-get "${opts[@]}" update &&
    sudo apt-get "${opts[@]}" install -y --no-install-recommends "${packages[@]}"; then
    exit 0
  fi
  echo "::warning::apt attempt $attempt failed; retrying in 20s"
  sleep 20
done
echo "::error::Could not install the Linux packages after 3 attempts"
exit 1
