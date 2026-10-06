# Changelog

## Unreleased

- GPU decoding: Settings has the grok accelerator plugin switch, licence and registration URL the wizards have. The setting applies at startup and on save, and a plugin that refuses to start turns it off with the reason in the status bar.
- Playback opens a player window of its own, as a normal window, while the transport and the library stay on the main window. Moving the pointer over the picture shows controls over it: play/pause, the scrubber with time, Stop and full screen. They fade out while playing and stay while paused or hovered. F, a double click or the full screen button go full screen on the display chosen in Settings, Escape leaves it, Space pauses, and Stop or closing the player window ends playback.
- Library, Keys, Jobs and Settings views: packages found under the library folders play in the player window, an encrypted composition with the KDM from the store that is valid now, and Verify runs dcpdoctor's strict check as a job.
