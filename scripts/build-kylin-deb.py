"""Assemble a standard DEB from a verified staging tree without target execution."""
import argparse
import hashlib
import io
import json
import lzma
import os
import pathlib
import re
import shutil
import stat
import tarfile
import tempfile
import uuid

PROJECT = pathlib.Path(__file__).resolve().parent.parent
STAGING = PROJECT / '.tmp' / 'kylin-deb'
EXECUTABLE_MODES = {
    'opt/data-fusion/data-fusion': 0o755,
    'opt/data-fusion/chrome_crashpad_handler': 0o755,
    'opt/data-fusion/chrome-sandbox': 0o4755,
}


def within(path, root):
    try:
        path.relative_to(root)
        return path != root
    except ValueError:
        return False


def regular_kind(path):
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
        raise ValueError('Linked or reparse paths cannot be packaged: ' + str(path))
    if not stat.S_ISDIR(info.st_mode) and not stat.S_ISREG(info.st_mode):
        raise ValueError('Only directories and ordinary files may be packaged')
    return info


def file_hash(path, algorithm='sha256'):
    digest = hashlib.new(algorithm)
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def parse_control(content):
    fields = {}
    for line in content.decode('utf-8').splitlines():
        if not line or line[0].isspace():
            continue
        if ':' not in line:
            raise ValueError('Invalid control field')
        key, value = line.split(':', 1)
        if key.lower() in fields:
            raise ValueError('Duplicate control field')
        fields[key.lower()] = value.strip()
    return fields


def inventory(stage):
    pending, entries = [stage], []
    while pending:
        directory = pending.pop()
        regular_kind(directory)
        for path in sorted(directory.iterdir(), key=lambda item: item.name):
            info = regular_kind(path)
            if not within(path.resolve(), stage):
                raise ValueError('Staged path escapes its tree')
            name = path.relative_to(stage).as_posix()
            if '\\' in name or any(ord(char) < 32 for char in name):
                raise ValueError('Invalid archive path')
            if name == 'DEBIAN':
                if not stat.S_ISDIR(info.st_mode):
                    raise ValueError('DEBIAN must be a directory')
                continue
            is_directory = stat.S_ISDIR(info.st_mode)
            digest = None if is_directory else file_hash(path, 'md5')
            entries.append((path, name, info, is_directory, digest))
            if is_directory:
                pending.append(path)
    return sorted(entries, key=lambda entry: entry[1])


def tar_info(name, size=0, mode=0o644, directory=False):
    info = tarfile.TarInfo('./' + name)
    info.uid = info.gid = 0
    info.uname = info.gname = 'root'
    info.mtime = 0
    info.mode = mode
    info.type = tarfile.DIRTYPE if directory else tarfile.REGTYPE
    info.size = 0 if directory else size
    return info


class CheckedReader:
    def __init__(self, source):
        self.source = source
        self.digest = hashlib.md5()

    def read(self, size=-1):
        data = self.source.read(size)
        self.digest.update(data)
        return data


def xz_gnu_tar(destination, emit):
    # Kylin V10's dpkg rejects PAX extension headers (type 'x'). GNU tar keeps
    # UTF-8 and long paths in its compatible long-name records instead.
    with destination.open('xb') as output:
        with lzma.LZMAFile(output, mode='w', format=lzma.FORMAT_XZ,
                           check=lzma.CHECK_CRC64, preset=6) as compressed:
            with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.GNU_FORMAT,
                              encoding='utf-8', errors='strict') as archive:
                emit(archive)


def ar_member(output, name, source, size):
    if len(name) > 15:
        raise ValueError('Unexpected DEB member name')
    header = ('%-16s%-12d%-6d%-6d%-8s%-10d`\n' % (name, 0, 0, 0, '100644', size)).encode('ascii')
    if len(header) != 60:
        raise ValueError('Invalid ar header')
    output.write(header)
    shutil.copyfileobj(source, output, 1024 * 1024)
    if size % 2:
        output.write(b'\n')


def build(stage, arch, version, destination):
    if arch not in ('x64', 'arm64') or not re.fullmatch(r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)', version):
        raise ValueError('Invalid version or architecture')
    regular_kind(stage)
    stage = stage.resolve()
    if not within(stage, STAGING.resolve()):
        raise ValueError('Use a stage below the project .tmp/kylin-deb directory')
    destination = destination.resolve()
    if not within(destination, PROJECT) or within(destination, stage):
        raise ValueError('Output must stay in the project outside the stage')
    control_path = stage / 'DEBIAN' / 'control'
    regular_kind(stage / 'DEBIAN')
    regular_kind(control_path)
    if sorted(path.name for path in (stage / 'DEBIAN').iterdir()) != ['control']:
        raise ValueError('This builder accepts only the staged control file; no maintainer scripts')
    control = control_path.read_bytes()
    fields = parse_control(control)
    expected_arch = 'amd64' if arch == 'x64' else 'arm64'
    if fields.get('package') != 'data-fusion-desktop' or fields.get('version') != version or fields.get('architecture') != expected_arch:
        raise ValueError('Control package/version/architecture does not match the build target')
    entries = inventory(stage)
    names = {entry[1] for entry in entries}
    for required in list(EXECUTABLE_MODES) + ['opt/data-fusion/resources/app.asar']:
        if required not in names:
            raise ValueError('Missing required staged resource: ' + required)
    for name in EXECUTABLE_MODES:
        with (stage / name).open('rb') as executable:
            header = executable.read(20)
        if len(header) != 20 or header[:4] != b'\x7fELF' or header[4:6] != b'\x02\x01' or int.from_bytes(header[18:20], 'little') != (62 if arch == 'x64' else 183):
            raise ValueError('Staged executable has the wrong ELF architecture: ' + name)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary_root = PROJECT / '.tmp'
    temporary_root.mkdir(exist_ok=True)
    partial = destination.with_name(destination.name + '.' + uuid.uuid4().hex + '.partial')
    try:
        with tempfile.TemporaryDirectory(prefix='kylin-deb-build-', dir=str(temporary_root)) as directory:
            directory = pathlib.Path(directory).resolve()
            if directory.parent != temporary_root.resolve():
                raise ValueError('Unexpected temporary build location')
            control_tar, data_tar = directory / 'control.tar.xz', directory / 'data.tar.xz'
            md5sums = ''.join(entry[4] + '  ' + entry[1] + '\n' for entry in entries if not entry[3]).encode('utf-8')
            def write_control(archive):
                archive.addfile(tar_info('', mode=0o755, directory=True))
                for name, content in [('control', control), ('md5sums', md5sums)]:
                    archive.addfile(tar_info(name, len(content)), io.BytesIO(content))
            xz_gnu_tar(control_tar, write_control)
            def write_data(archive):
                archive.addfile(tar_info('', mode=0o755, directory=True))
                for path, name, original, is_directory, digest in entries:
                    current = regular_kind(path)
                    if current.st_size != original.st_size or current.st_mtime_ns != original.st_mtime_ns:
                        raise ValueError('Staged content changed during assembly: ' + name)
                    if is_directory:
                        archive.addfile(tar_info(name, mode=0o755, directory=True))
                    else:
                        with path.open('rb') as source:
                            reader = CheckedReader(source)
                            archive.addfile(tar_info(name, original.st_size, EXECUTABLE_MODES.get(name, 0o644)), reader)
                            if reader.digest.hexdigest() != digest:
                                raise ValueError('Staged bytes changed during assembly: ' + name)
            xz_gnu_tar(data_tar, write_data)
            with partial.open('xb') as output:
                output.write(b'!<arch>\n')
                ar_member(output, 'debian-binary', io.BytesIO(b'2.0\n'), 4)
                for name, path in [('control.tar.xz', control_tar), ('data.tar.xz', data_tar)]:
                    with path.open('rb') as source:
                        ar_member(output, name, source, path.stat().st_size)
                output.flush()
                os.fsync(output.fileno())
            if partial.stat().st_size > 500 * 1024 * 1024:
                raise ValueError('Package exceeds the release upload limit')
            os.replace(str(partial), str(destination))
    finally:
        if partial.exists():
            partial.unlink()
    return {'file': str(destination), 'stage': str(stage), 'version': version, 'arch': arch,
            'bytes': destination.stat().st_size, 'sha256': file_hash(destination), 'dataEntries': len(entries),
            'asarSha256': file_hash(stage / 'opt/data-fusion/resources/app.asar'), 'targetExecuted': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--arch', required=True, choices=['x64', 'arm64'])
    parser.add_argument('--stage', type=pathlib.Path)
    args = parser.parse_args()
    package_version = json.loads((PROJECT / 'package.json').read_text(encoding='utf-8'))['version']
    deb_arch = 'amd64' if args.arch == 'x64' else 'arm64'
    stage = args.stage
    if stage is None:
        candidates = sorted(STAGING.glob(package_version + '-' + deb_arch + '-*'), key=lambda path: path.stat().st_mtime_ns)
        if not candidates:
            parser.error('No matching staged package; run scripts/stage-kylin-deb.mjs first')
        stage = candidates[-1]
    destination = PROJECT / 'release' / package_version / 'kylin' / ('数据融合助手-麒麟版-%s-%s.deb' % (package_version, args.arch))
    result = build(stage, args.arch, package_version, destination)
    print(json.dumps(result, ensure_ascii=False))
