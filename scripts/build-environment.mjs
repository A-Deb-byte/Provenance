const inheritedBuildEnvironmentNames = Object.freeze([
  'APPDATA',
  'COMSPEC',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'DEVENVDIR',
  'EXTENSIONSDKDIR',
  'FRAMEWORKDIR',
  'FRAMEWORKDIR64',
  'FRAMEWORKVERSION',
  'FRAMEWORKVERSION64',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'INCLUDE',
  'LANG',
  'LC_ALL',
  'LIB',
  'LIBPATH',
  'LOCALAPPDATA',
  'NETFXSDKDIR',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'PROVENANCE_CARGO_ABOUT',
  'PROVENANCE_CARGO_ABOUT_SHA256',
  'PROVENANCE_CARGO_ABOUT_VERSION',
  'SOURCE_DATE_EPOCH',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TZ',
  'UCRTVERSION',
  'UNIVERSALCRTSDKDIR',
  'USERPROFILE',
  'VCIDEINSTALLDIR',
  'VCINSTALLDIR',
  'VCTOOLSINSTALLDIR',
  'VCTOOLSREDISTDIR',
  'VISUALSTUDIOVERSION',
  'VSCMD_ARG_APP_PLAT',
  'VSCMD_ARG_HOST_ARCH',
  'VSCMD_ARG_TGT_ARCH',
  'VSCMD_VER',
  'WINDIR',
  'WINDOWSLIBPATH',
  'WINDOWSSDKBINPATH',
  'WINDOWSSDKDIR',
  'WINDOWSSDKLIBVERSION',
  'WINDOWSSDKVERSION',
  '__VSCMD_PREINIT_PATH',
]);

const canonicalBuildEnvironmentNames = new Map(
  inheritedBuildEnvironmentNames.map((name) => [name.toUpperCase(), name]),
);

export function sanitizedBuildEnvironment(environment) {
  const sanitized = {};
  for (const [name, value] of Object.entries(environment)) {
    const canonicalName = canonicalBuildEnvironmentNames.get(name.toUpperCase());
    if (!canonicalName || typeof value !== 'string') continue;
    if (Object.hasOwn(sanitized, canonicalName) && sanitized[canonicalName] !== value) {
      throw new Error(`Build environment contains conflicting forms of ${canonicalName}.`);
    }
    sanitized[canonicalName] = value;
  }
  return sanitized;
}
