# DCP Screen

DCP Screen plays DCPs from a library of folders, with the KDM for an encrypted composition picked from a store of KDMs. It is a thin Tauri app over postkit and guikit, and verifies packages with dcpdoctor.

## Build

Linux only for now. The submodules come first:

```bash
git submodule update --init --recursive
```

Grok (libgrokj2k), FFmpeg and libmpv must be discoverable by pkg-config at build time, as for the wizards:

```bash
export PKG_CONFIG_PATH="/path/to/ffmpeg-mpv/lib/pkgconfig:/path/to/grok/lib64/pkgconfig:$PKG_CONFIG_PATH"
export LD_LIBRARY_PATH=/path/to/grok/lib64

cd gui
pnpm install
pnpm build
pnpm test

cd src-tauri
cargo build
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt -- --check
```

`pnpm tauri build --no-bundle` builds the release binary at `gui/src-tauri/target/release/dcpscreen-gui`.

## Run

```bash
export LD_LIBRARY_PATH=/path/to/grok/lib64
export GRK_PLUGIN_PATH=/path/to/grok/lib64
./gui/src-tauri/target/debug/dcpscreen-gui
```

Play opens the player window on the display named in Settings, or on the main window's display when none is named or it is not connected. On Wayland a player window that is not full screen opens wherever the compositor puts it.

grok looks for `libgrokj2k_plugin` in the directory `GRK_PLUGIN_PATH` names, then in the working directory, then in the executable's own directory, and never on `LD_LIBRARY_PATH`. Without the plugin the player decodes on the CPU. `GRK_NO_PLUGIN=1` keeps grok on the CPU even when the plugin is found.

Settings are kept in `~/.config/dcpscreen/settings.json`. The library (`library.json`), the KDM store (`kdms/`) and the verify jobs (`jobs.jsonl`) are kept in `~/.local/share/dcpscreen`. `XDG_CONFIG_HOME` and `XDG_DATA_HOME` move them, and `DCPSCREEN_JOBS_FILE` names a jobs file of its own. The library is refreshed from the folders in Settings at startup and prints what it found as `[library] refresh: ...` on stdout.
