export function settingsFromFields({ libraryRoots, recipientCertificate, recipientKey }) {
  return {
    libraryRoots,
    recipientCertificate: recipientCertificate || null,
    recipientKey: recipientKey || null,
  };
}

export function withLibraryRoot(libraryRoots, folder) {
  return libraryRoots.includes(folder) ? libraryRoots : [...libraryRoots, folder];
}

export function withoutLibraryRoot(libraryRoots, index) {
  return libraryRoots.filter((_, rootIndex) => rootIndex !== index);
}
