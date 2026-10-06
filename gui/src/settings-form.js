export function settingsFromFields({
  libraryRoots,
  recipientCertificate,
  recipientKey,
  gpu,
  gpuLicense,
  gpuRegistrationUrl,
  playerMonitor,
  requireHdcp,
}) {
  return {
    libraryRoots,
    recipientCertificate: recipientCertificate || null,
    recipientKey: recipientKey || null,
    gpu,
    gpuLicense: gpuLicense || null,
    gpuRegistrationUrl: gpuRegistrationUrl || null,
    playerMonitor: playerMonitor || null,
    requireHdcp,
  };
}

export function withLibraryRoot(libraryRoots, folder) {
  return libraryRoots.includes(folder) ? libraryRoots : [...libraryRoots, folder];
}

export function withoutLibraryRoot(libraryRoots, index) {
  return libraryRoots.filter((_, rootIndex) => rootIndex !== index);
}
