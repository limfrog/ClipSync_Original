const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'darwin') {
    const appPath = path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`
    );
    try {
      execFileSync('/usr/bin/xattr', ['-cr', appPath], { stdio: 'ignore' });
    } catch {}
    try {
      execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], {
        stdio: 'inherit'
      });
    } catch (err) {
      console.warn('Ad-hoc codesign warning:', err.message);
    }
    try {
      execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', '-r', appPath], {
        stdio: 'ignore'
      });
    } catch {}
  }
};
