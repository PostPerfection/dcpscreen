fn main() {
    // a packaged libgrokj2k goes in /usr/lib/dcpscreen, not beside the binary
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo:rustc-link-arg-bins=-Wl,-rpath,/usr/lib/dcpscreen");
    }
    postkit_ffmpeg_link_search::emit_ffmpeg_link_search();
    tauri_build::build()
}
