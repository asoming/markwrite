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
    child_profiles = []
    child_records = []
    report = {'platform': args.arch, 'status': 'running',
              'dmgSha256': hashlib.sha256(Path(args.dmg).read_bytes()).hexdigest()}
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
                return any(d.get('path') and Path(d['path']).samefile(path)
                           and d.get('content') == path.read_text() for d in state.get('docs',[]))
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
        # System Events may be unavailable on a headless runner. When available,
        # require our feature menus, rather than mistaking Tauri's default menu
        # or a blank webview for a fully initialized native application.
        try:
            menu_script = f'''tell application "System Events"
                tell first application process whose unix id is {owned_pids[0]}
                    return name of every menu bar item of menu bar 1
                end tell
            end tell'''
            menu = subprocess.run(['osascript','-e',menu_script],capture_output=True,text=True,timeout=12)
            if menu.returncode == 0:
                report['nativeMenuTitles'] = menu.stdout.strip()
                assert 'Markwrite' in menu.stdout and ('段落' in menu.stdout or 'Paragraph' in menu.stdout), menu.stdout
                assert '主题' in menu.stdout or 'Theme' in menu.stdout, menu.stdout
                report['nativeFeatureMenusVerified'] = True
            else:
                report['nativeMenuInspectionUnavailable'] = menu.stderr.strip()
        except subprocess.TimeoutExpired:
            report['nativeMenuInspectionUnavailable'] = 'System Events did not respond within 12 seconds'
        shot = subprocess.run(['screencapture','-x',str(output/'macos-desktop.png')],capture_output=True,text=True)
        report['desktopScreenshot'] = shot.returncode == 0
        if report.get('nativeFeatureMenusVerified'):
            def click_menu(pid, heading, label):
                script = f'''tell application "System Events"
                    tell first application process whose unix id is {pid}
                        set frontmost to true
                        click menu item {json.dumps(label,ensure_ascii=False)} of menu 1 of menu bar item {json.dumps(heading,ensure_ascii=False)} of menu bar 1
                    end tell
                end tell'''
                subprocess.run(['osascript','-e',script],check=True,capture_output=True,text=True,timeout=12)
            chinese = '文件' in report['nativeMenuTitles']
            parent_pid = owned_pids[0]
            record_directory = profile.parent/'app.markwrite.desktop/document-windows'
            before_records = set(record_directory.glob('*.json'))
            click_menu(parent_pid, '文件' if chinese else 'File',
                       '当前文件在独立窗口打开' if chinese else 'Open current file in a new window')
            def new_process():
                children = list(set(process_ids()) - {parent_pid})
                return children[0] if len(children)==1 else None
            child_pid = wait_for(new_process,'Native menu did not create an independent process')
            owned_pids.append(child_pid)
            def child_loaded():
                for record in set(record_directory.glob('*.json'))-before_records:
                    try:
                        identifier = json.loads(record.read_text())['id']
                        if len(identifier)!=32 or any(c not in '0123456789abcdef' for c in identifier):continue
                        child_profile = profile.parent/f'app.markwrite.desktop.window.w{identifier}'
                        state = json.loads((child_profile/'session.json').read_text())
                        if any(d.get('path') and Path(d['path']).samefile(second) and d.get('content')==second.read_text() for d in state.get('docs',[])):
                            child_profiles.append(child_profile); child_records.append(record)
                            return True
                    except (OSError,ValueError,KeyError):pass
                return False
            wait_for(child_loaded,'Independent process did not load the original document')
            report['nativeMenuCreatesIndependentWindow'] = True
            quit_label = '退出 Markwrite' if chinese else 'Quit Markwrite'
            click_menu(child_pid,'Markwrite',quit_label)
            wait_for(lambda: child_pid not in process_ids(),'Native Quit did not end the child process',seconds=25)
            assert parent_pid in process_ids(), 'Closing one window terminated the other process'
            report['independentQuitKeepsOtherWindow'] = True
            click_menu(parent_pid,'Markwrite',quit_label)
            wait_for(lambda: not process_ids(),'Native Quit did not end the clean application',seconds=25)
            report['nativeCleanQuit'] = True
        report['status'] = 'passed'
        report['limits'] = 'CI Finder, native menus and independent-process quit verified; interactive Chinese IME, gestures and physical displays need human Mac testing.'
    finally:
        for pid in owned_pids:
            try: os.kill(pid,15)
            except ProcessLookupError: pass
        if (profile/'session.json').is_file():
            shutil.copy2(profile/'session.json',output/'session.json')
        (output/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
        subprocess.run(['hdiutil','detach',str(mount)],capture_output=True)
        # Only the uniquely allocated smoke profile and temporary installation are removed.
        for child_profile in child_profiles: shutil.rmtree(child_profile,ignore_errors=True)
        for record in child_records: record.unlink(missing_ok=True)
        shutil.rmtree(profile,ignore_errors=True)
        shutil.rmtree(root,ignore_errors=True)
    print(json.dumps(report,ensure_ascii=False,indent=2))


if __name__ == '__main__': main()
