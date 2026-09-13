"""Verify and launch a relocated DMG app on a disposable macOS CI runner."""
from pathlib import Path
import argparse, hashlib, json, os, plistlib, shutil, subprocess, tempfile, time


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT).strip()


def wait_for(probe, message, seconds=60):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = probe()
        if value:
            return value
        time.sleep(.5)
    raise AssertionError(message)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dmg', required=True)
    parser.add_argument('--arch', required=True, choices=['arm64', 'x86_64'])
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    output = Path(args.output).resolve(); output.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix='markwrite-macos-')).resolve()
    mount = root / 'Mounted'; mount.mkdir()
    app = root / '安装 with spaces' / 'Markwrite.app'; app.parent.mkdir()
    profile_id = hashlib.sha256(str(root).encode()).hexdigest()[:32]
    profile = Path.home() / 'Library/Application Support' / f'app.markwrite.desktop.window.w{profile_id}'
    executable = str(app / 'Contents/MacOS/markwrite')
    owned_pids = []
    report = {'platform': args.arch, 'status': 'running'}
    try:
        run('hdiutil','verify',args.dmg)
        run('hdiutil','attach','-readonly','-nobrowse','-mountpoint',str(mount),args.dmg)
        source = mount / 'Markwrite.app'
        assert source.is_dir(), 'DMG has no application'
        run('ditto', str(source), str(app))
        run('hdiutil','detach',str(mount))
        info = plistlib.loads((app/'Contents/Info.plist').read_bytes())
        assert info['CFBundleIdentifier'] == 'app.markwrite.desktop'
        assert info['LSMinimumSystemVersion'] == '14.0'
        assert set(run('lipo','-archs',executable).split()) == {args.arch}
        associations = info['CFBundleDocumentTypes']
        assert any('net.daringfireball.markdown' in a.get('LSItemContentTypes',[]) for a in associations)
        assert (app/'Contents/Resources'/info['CFBundleIconFile']).exists()
        run('codesign','--verify','--deep','--strict',str(app))
        links = run('otool','-L',executable)
        assert '/opt/homebrew/' not in links and '/usr/local/' not in links, links
        report.update(dmgVerified=True, relocatedBundleSignature=True, nativeArchitecture=True, markdownAssociation=True, dynamicLibraries=links)
        docs = root/'演示 文档'; docs.mkdir()
        first, second = docs/'冷启动 #1.md', docs/'运行中打开 2.markdown'
        first.write_text('# macOS 冷启动\n\n来自 Finder 的原文件。\n', encoding='utf-8')
        second.write_text('# macOS 热启动\n\n另一篇文件，保留原目录。\n', encoding='utf-8')
        originals = {p: p.read_bytes() for p in [first,second]}
        run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister','-f',str(app))
        run('open','-n','-a',str(app),str(first),'--args','--markwrite-window',profile_id)
        def sessions_contain(path):
            try:
                state = json.loads((profile/'session.json').read_text())
                return any(d.get('path') == str(path) and d.get('content') == path.read_text() for d in state.get('docs',[]))
            except (OSError,ValueError):
                return False
        def process_ids():
            found = subprocess.run(['pgrep','-f',executable],capture_output=True,text=True)
            return [int(p) for p in found.stdout.split()]
        owned_pids = wait_for(process_ids,'Installed app did not start')
        wait_for(lambda: sessions_contain(first),'Cold Finder open did not reach frontend recovery session')
        report['finderColdOpenAndFrontendSession'] = True
        run('open','-a',str(app),str(second))
        wait_for(lambda: sessions_contain(second),'Warm Finder open did not reach frontend session')
        assert sessions_contain(first), 'Second file replaced the first buffer'
        assert process_ids() == owned_pids, 'Warm open unexpectedly created a new process'
        report['finderWarmOpenSameProcess'] = True
        assert all(p.read_bytes()==data for p,data in originals.items()), 'Read-only open modified a source'
        report['sourceFilesUnchanged'] = True
        shot = subprocess.run(['screencapture','-x',str(output/'macos-desktop.png')],capture_output=True,text=True)
        report['desktopScreenshot'] = shot.returncode == 0
        report['status'] = 'passed'
        report['limits'] = 'CI launch and Finder integration only; interactive Chinese IME, gestures and physical displays need human Mac testing.'
    finally:
        for pid in owned_pids:
            try: os.kill(pid,15)
            except ProcessLookupError: pass
        if (profile/'session.json').is_file():
            shutil.copy2(profile/'session.json',output/'session.json')
        (output/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
        subprocess.run(['hdiutil','detach',str(mount)],capture_output=True)
        # Only the uniquely allocated smoke profile and temporary installation are removed.
        shutil.rmtree(profile,ignore_errors=True)
        shutil.rmtree(root,ignore_errors=True)
    print(json.dumps(report,ensure_ascii=False,indent=2))


if __name__ == '__main__': main()
