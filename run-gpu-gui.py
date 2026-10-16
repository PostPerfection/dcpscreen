#!/usr/bin/env python3
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

root = Path(__file__).resolve().parent
gui_dir = root / "gui"
default_grok_root = Path.home() / "bin" / "grok-gpu"
gui_manifest = gui_dir / "src-tauri" / "Cargo.toml"
local_registration_url = "http://127.0.0.1:8787/api/register"
development_license = "DEV-LICENCE"
registration_server_port = 8787
license_server_bootstrap = (
    'import { readFileSync } from "node:fs";'
    'import { pathToFileURL } from "node:url";'
    "const [serverScript, privateKey, license, licenseKeyPath, port] = process.argv.slice(1);"
    "process.argv = [process.argv[0], serverScript, privateKey, license, "
    "readFileSync(licenseKeyPath, 'utf8').trim(), port];"
    "await import(pathToFileURL(serverScript));"
)


def prepend_path(name, directory):
    directory = str(directory)
    current = os.environ.get(name)
    os.environ[name] = directory if not current else directory + os.pathsep + current


def platform_layout():
    if sys.platform.startswith("linux"):
        return {
            "plugin_names": ["libgrokj2k_plugin.so"],
            "lib_dirs": ["lib64", "lib"],
            "loader_var": "LD_LIBRARY_PATH",
            "kernels": None,
        }
    if sys.platform == "darwin":
        return {
            "plugin_names": ["libgrokj2k_plugin.dylib"],
            "lib_dirs": ["lib", "lib64"],
            "loader_var": "DYLD_LIBRARY_PATH",
            "kernels": "grok_kernels.metallib",
        }
    if sys.platform == "win32":
        return {
            "plugin_names": ["grokj2k_plugin.dll", "libgrokj2k_plugin.dll"],
            "lib_dirs": ["bin", "lib", "lib64"],
            "loader_var": "PATH",
            "kernels": None,
        }
    sys.exit(f"no GPU GUI launch for {sys.platform}")


def find_lib_dir(grok_root, layout):
    searched = []
    candidates = [grok_root / name for name in layout["lib_dirs"]]
    candidates.append(grok_root)
    for directory in candidates:
        searched.append(directory)
        if any((directory / plugin).is_file() for plugin in layout["plugin_names"]):
            return directory
    names = " or ".join(layout["plugin_names"])
    places = ", ".join(str(path) for path in searched)
    sys.exit(f"no {names} under {grok_root} (looked in {places})")


def pkgconfig_dir(grok_root, lib_dir):
    for directory in (
        lib_dir / "pkgconfig",
        grok_root / "lib" / "pkgconfig",
        grok_root / "lib64" / "pkgconfig",
    ):
        if directory.is_dir():
            return directory
    return None


def run(*command, cwd=root):
    subprocess.run(command, cwd=cwd, check=True)


def grok_runtime_library():
    if sys.platform.startswith("linux"):
        return "libgrokj2k.so.1"
    if sys.platform == "darwin":
        return "libgrokj2k.1.dylib"
    if sys.platform == "win32":
        return "grokj2k.dll"
    return None


def stage_grok_library(lib_dir):
    name = grok_runtime_library()
    if not name:
        return
    src = lib_dir / name
    if not src.is_file():
        sys.exit(f"no {name} in {lib_dir}")
    dest = gui_dir / "src-tauri" / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)


def settings_path():
    if config_home := os.environ.get("XDG_CONFIG_HOME"):
        return Path(config_home) / "dcpscreen" / "settings.json"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "dcpscreen" / "settings.json"
    if sys.platform == "win32" and (application_data := os.environ.get("APPDATA")):
        return Path(application_data) / "dcpscreen" / "settings.json"
    return Path.home() / ".config" / "dcpscreen" / "settings.json"


def registration_server_is_running():
    try:
        with socket.create_connection(("127.0.0.1", registration_server_port), timeout=0.2):
            return True
    except OSError:
        return False


def gpu_plugin_source():
    candidates = (
        root.parent.parent / "Grok" / "grok" / "extern" / "grok-gpu-plugin",
        Path.home() / "src" / "Grok" / "grok" / "extern" / "grok-gpu-plugin",
    )
    for candidate in candidates:
        if (candidate / "tools" / "license_server" / "dev_register_server.ts").is_file():
            return candidate
    return None


def start_local_registration_server():
    stored_settings_path = settings_path()
    if not stored_settings_path.is_file():
        return
    try:
        settings = json.loads(stored_settings_path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        sys.exit(f"could not read {stored_settings_path}: {error}")
    if settings.get("gpuRegistrationUrl") != local_registration_url:
        return
    if settings.get("gpuLicense") != development_license:
        sys.exit(f"{local_registration_url} requires the {development_license} development license")
    if registration_server_is_running():
        return

    plugin_source = gpu_plugin_source()
    if plugin_source is None:
        sys.exit("could not find the grok-gpu-plugin source for the local registration server")
    key_directory = Path.home() / ".config" / "gpup_license_keys"
    private_key = key_directory / "dev_private_key.pem"
    license_key = key_directory / "dev_license_key.hex"
    if not private_key.is_file() or not license_key.is_file():
        sys.exit(f"local registration server keys are missing under {key_directory}")

    server_script = plugin_source / "tools" / "license_server" / "dev_register_server.ts"
    server_process = subprocess.Popen(
        [
            "node",
            "--input-type=module",
            "--eval",
            license_server_bootstrap,
            server_script,
            private_key,
            development_license,
            license_key,
            str(registration_server_port),
        ],
        cwd=plugin_source,
    )
    for _ in range(50):
        if registration_server_is_running():
            return
        if server_process.poll() is not None:
            sys.exit("the local registration server exited during startup")
        time.sleep(0.1)
    server_process.terminate()
    sys.exit(f"the local registration server did not open port {registration_server_port}")


layout = platform_layout()
grok_root = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else default_grok_root
lib_dir = find_lib_dir(grok_root, layout)
if layout["kernels"] and not (lib_dir / layout["kernels"]).is_file():
    sys.exit(f"no {layout['kernels']} in {lib_dir}")

pkgconfig = pkgconfig_dir(grok_root, lib_dir)
if pkgconfig:
    prepend_path("PKG_CONFIG_PATH", pkgconfig)
prepend_path(layout["loader_var"], lib_dir)
os.environ["GRK_PLUGIN_PATH"] = str(lib_dir)
start_local_registration_server()

stage_grok_library(lib_dir)
# grokj2k-sys caches the grok it last linked
run("cargo", "clean", "-q", "-p", "grokj2k-sys", "--manifest-path", gui_manifest)
run("pnpm", "tauri", "build", "--no-bundle", "--ignore-version-mismatches", cwd=gui_dir)

gui_bin = gui_dir / "src-tauri" / "target" / "release" / (
    "dcpscreen-gui.exe" if sys.platform == "win32" else "dcpscreen-gui"
)
os.execv(gui_bin, [str(gui_bin), *sys.argv[2:]])
