import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export async function installDaemon(): Promise<void> {
  // Resolve absolute paths — never rely on PATH in launchd context
  const nodePath = execSync('which node').toString().trim();
  const claudewatchPath = execSync('which claudewatch').toString().trim();
  const homeDir = homedir();
  const logPath = join(homeDir, '.claudewatch/daemon.log');
  const plistPath = join(homeDir, 'Library/LaunchAgents/com.claudewatch.daemon.plist');

  if (!claudewatchPath) {
    console.error('✗ claudewatch binary not found. Run: npm link');
    process.exit(1);
  }
  if (!nodePath) {
    console.error('✗ node binary not found in PATH');
    process.exit(1);
  }

  // If the claudewatch bin is a JS/shell wrapper (from npm link), invoke it via
  // node explicitly so launchd doesn't need to resolve shebangs via a minimal PATH.
  let programArgs: string[];
  try {
    const firstLine = execSync(`head -1 ${claudewatchPath}`).toString().trim();
    if (firstLine.includes('node')) {
      programArgs = [nodePath, claudewatchPath, 'daemon'];
    } else {
      programArgs = [claudewatchPath, 'daemon'];
    }
  } catch {
    programArgs = [nodePath, claudewatchPath, 'daemon'];
  }

  const plistArgs = programArgs
    .map(arg => `    <string>${arg}</string>`)
    .join('\n');

  const userPath = execSync('echo $PATH').toString().trim();

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claudewatch.daemon</string>

  <key>ProgramArguments</key>
  <array>
${plistArgs}
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${userPath}</string>
    <key>HOME</key>
    <string>${homeDir}</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>30</integer>

  <key>StandardOutPath</key>
  <string>${logPath}</string>

  <key>StandardErrorPath</key>
  <string>${logPath}</string>

  <key>ProcessType</key>
  <string>Background</string>

  <key>WorkingDirectory</key>
  <string>${homeDir}</string>
</dict>
</plist>`;

  execSync(`mkdir -p ${join(homeDir, '.claudewatch')}`);
  execSync(`touch ${logPath}`);

  writeFileSync(plistPath, plist);
  console.log(`✓ Plist written → ${plistPath}`);

  execSync(`launchctl unload ${plistPath} 2>/dev/null || true`);
  execSync(`launchctl load -w ${plistPath}`);
  console.log('✓ Service loaded');

  await new Promise<void>(r => setTimeout(r, 3000));
  try {
    const status = execSync('launchctl list com.claudewatch.daemon').toString();
    const pid = status.match(/"PID"\s*=\s*(\d+)/)?.[1];
    if (pid) {
      writeFileSync(join(homeDir, '.claudewatch/daemon.pid'), pid);
      console.log(`✓ Daemon running (PID ${pid})`);
      console.log(`  Logs → ${logPath}`);
      console.log(`  Tip  → claudewatch logs -f`);
    } else {
      console.error('✗ Daemon registered but not running.');
      console.error('  Check logs: claudewatch logs -f');
      console.error('  Or: tail -50 ' + logPath);
    }
  } catch {
    console.error('✗ Could not verify daemon status');
  }
}

export async function uninstallDaemon(): Promise<void> {
  const plistPath = join(homedir(), 'Library/LaunchAgents/com.claudewatch.daemon.plist');
  execSync(`launchctl unload ${plistPath} 2>/dev/null || true`);
  execSync(`rm -f ${plistPath}`);
  console.log('✓ ClaudeWatch daemon uninstalled');
}
