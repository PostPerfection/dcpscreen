const PATH_SEPARATORS = /[\\/]/;

function fileName(path) {
  return path.split(PATH_SEPARATORS).pop();
}

export function playRefusalText(compositionTitle, kdms) {
  if (!kdms.length) return `Keys holds no KDM for ${compositionTitle}.`;
  const reasons = kdms.map(({ path, fit }) => `${fileName(path)}: ${fit}`);
  return [`No KDM opens ${compositionTitle} now.`, ...reasons].join("\n");
}
