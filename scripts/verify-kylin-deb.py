"""Independently inspect DEB archives and compare all payload bytes to a stage."""
import argparse
import hashlib
import io
import json
import lzma
import pathlib
import stat
import tarfile


def digest_file(path):
    sha, md5 = hashlib.sha256(), hashlib.md5()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            sha.update(block)
            md5.update(block)
    return sha.hexdigest(), md5.hexdigest()


def ar_contents(path):
    result = {}
    with path.open('rb') as source:
        if source.read(8) != b'!<arch>\n':
            raise ValueError('Invalid ar signature')
        while True:
            header = source.read(60)
            if not header:
                break
            if len(header) != 60 or header[58:] != b'`\n':
                raise ValueError('Invalid ar member header')
            name = header[:16].decode('ascii').strip()
            if '/' in name:
                raise ValueError('DEB ar member names must not use a trailing slash')
            size = int(header[48:58].decode('ascii').strip())
            if name in result or size <= 0 or size > 500 * 1024 * 1024:
                raise ValueError('Duplicate or oversized ar member')
            if int(header[16:28].decode('ascii').strip()) != 0 or int(header[28:34].decode('ascii').strip()) != 0 or int(header[34:40].decode('ascii').strip()) != 0:
                raise ValueError('Non-root or nondeterministic ar metadata')
            if int(header[40:48].decode('ascii').strip(), 8) != 0o100644:
                raise ValueError('Invalid ar member permissions')
            content = source.read(size)
            if len(content) != size or size % 2 and source.read(1) != b'\n':
                raise ValueError('Truncated or unpadded ar member')
            result[name] = content
    if list(result) != ['debian-binary', 'control.tar.xz', 'data.tar.xz'] or result['debian-binary'] != b'2.0\n':
        raise ValueError('Unexpected DEB structure')
    return result


def check_gnu_tar(content):
    """Inspect raw headers too: tarfile hides PAX headers from iteration."""
    total = 0
    with lzma.LZMAFile(io.BytesIO(content), mode='r') as archive:
        while True:
            header = archive.read(512)
            total += len(header)
            if len(header) != 512:
                raise ValueError('Truncated GNU tar header or missing terminator')
            if not any(header):
                if archive.read(512) != bytes(512):
                    raise ValueError('Invalid GNU tar terminator')
                tail = archive.read(10240)
                if any(tail) or archive.read(1):
                    raise ValueError('Unexpected data after GNU tar terminator')
                return
            if header[156:157] in (b'x', b'g', b'X'):
                raise ValueError('PAX extension headers are not compatible with Kylin V10')
            if header[257:265] != b'ustar  \0' or header[156:157] not in (b'0', b'\0', b'5', b'L'):
                raise ValueError('Expected compatible GNU tar headers')
            try:
                size = int(header[124:136].rstrip(b'\0 ').strip() or b'0', 8)
            except ValueError:
                raise ValueError('Invalid GNU tar entry size')
            if size < 0:
                raise ValueError('Invalid GNU tar entry size')
            remaining = (size + 511) // 512 * 512
            total += remaining
            if total > 2 * 1024 * 1024 * 1024:
                raise ValueError('GNU tar exceeds verification limit')
            while remaining:
                block = archive.read(min(remaining, 1024 * 1024))
                if not block:
                    raise ValueError('Truncated GNU tar payload')
                remaining -= len(block)


def check_root(member):
    if member.name not in ('.', './') or not member.isdir():
        raise ValueError('GNU tar must start with its root directory')
    check_owner(member, 0o755)


def safe_name(value):
    try:
        value.encode('utf-8', errors='strict')
    except UnicodeEncodeError:
        raise ValueError('Archive paths must be valid UTF-8')
    name = value[2:] if value.startswith('./') else value
    path = pathlib.PurePosixPath(name)
    if not name or path.is_absolute() or '..' in path.parts or '\\' in name or any(ord(char) < 32 for char in name):
        raise ValueError('Unsafe archive path')
    return path.as_posix()


def check_owner(member, mode):
    if member.uid != 0 or member.gid != 0 or member.uname != 'root' or member.gname != 'root' or member.mode != mode or member.mtime != 0:
        raise ValueError('Incorrect archive owner, permission or timestamp: ' + member.name)


def verify(package, stage, arch, version, compatibility=None, deployment=None):
    if deployment not in (None, 'huizhou-intranet'):
        raise ValueError('Invalid fixed-shell deployment identity')
    app_root = 'opt/huizhou-data-fusion' if deployment else 'opt/data-fusion'
    stage = stage.resolve()
    ar = ar_contents(package)
    for name in ('control.tar.xz', 'data.tar.xz'):
        check_gnu_tar(ar[name])
    control = {}
    with tarfile.open(fileobj=io.BytesIO(ar['control.tar.xz']), mode='r|xz',
                      encoding='utf-8', errors='surrogateescape') as archive:
        for index, member in enumerate(archive):
            if index == 0:
                check_root(member)
                continue
            name = safe_name(member.name)
            if name in control or not member.isfile() or member.size > 1024 * 1024:
                raise ValueError('Invalid control member')
            check_owner(member, 0o644)
            control[name] = archive.extractfile(member).read()
    if set(control) != {'control', 'md5sums'}:
        raise ValueError('Unexpected control files or maintainer scripts')
    fields = dict(line.split(':', 1) for line in control['control'].decode('utf-8').splitlines() if line and not line[0].isspace())
    package_name = 'huizhou-data-fusion-desktop' if deployment else 'data-fusion-desktop'
    if fields.get('Package', '').strip() != package_name or fields.get('Version', '').strip() != version or fields.get('Architecture', '').strip() != ('amd64' if arch == 'x64' else 'arm64'):
        raise ValueError('Control metadata mismatch')
    if control['control'] != (stage / 'DEBIAN/control').read_bytes():
        raise ValueError('Staged control bytes changed')
    md5sums = {}
    for line in control['md5sums'].decode('utf-8').splitlines():
        checksum, name = line.split('  ', 1)
        if name in md5sums:
            raise ValueError('Duplicate checksum path')
        md5sums[safe_name(name)] = checksum
    expected = {}
    pending = [stage]
    while pending:
        directory = pending.pop()
        for path in directory.iterdir():
            if path == stage / 'DEBIAN':
                continue
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                raise ValueError('Linked staged path')
            name = path.relative_to(stage).as_posix()
            expected[name] = path
            if path.is_dir():
                pending.append(path)
    if deployment and any(name == 'opt/data-fusion' or name.startswith('opt/data-fusion/')
                          or name == 'usr/share/applications/cn.zzkj.datafusion.desktop'
                          or name == 'usr/share/icons/hicolor/512x512/apps/data-fusion.png' for name in expected):
        raise ValueError('Huizhou package cannot contain Shenzhen installation paths')
    executable_modes = {app_root + '/data-fusion': 0o755, app_root + '/chrome_crashpad_handler': 0o755,
                        app_root + '/chrome-sandbox': 0o4755}
    elf_names = set(executable_modes)
    if compatibility is not None:
        if compatibility != 'kirin990' or arch != 'arm64':
            raise ValueError('Kirin990 variant must use ARM64')
        private = stage / app_root / 'resources/compat/kirin990'
        metadata = json.loads((private / 'provenance.json').read_text(encoding='utf-8'))
        if metadata.get('variant') != 'kirin990-arm64' or metadata.get('architecture') != 'arm64' or metadata.get('nativeExecutable') != 'data-fusion.bin' or metadata.get('rendererSandbox') is not True:
            raise ValueError('Invalid compatibility metadata')
        wrapper = stage / app_root / 'data-fusion'
        reviewed = pathlib.Path(__file__).resolve().parent.parent / 'resources/kirin990-launcher.sh'
        if wrapper.read_bytes() != reviewed.read_bytes().replace(b'\r\n', b'\n') or digest_file(wrapper)[0] != metadata.get('launcherSha256'):
            raise ValueError('Compatibility launcher differs from reviewed source')
        if digest_file(stage / app_root / 'data-fusion.bin')[0] != metadata.get('nativeSha256'):
            raise ValueError('Compatibility native executable changed')
        executable_modes[app_root + '/data-fusion.bin'] = 0o755
        elf_names = set(executable_modes) - {app_root + '/data-fusion'}
        if not any(entry.get('path') == 'libgbm.so.1' for entry in metadata.get('files', [])):
            raise ValueError('Private GBM is absent')
        for entry in metadata['files']:
            name = entry.get('path', '')
            if safe_name(name) != name or '/' in name or digest_file(private / name)[0] != entry.get('sha256'):
                raise ValueError('Private compatibility file changed')
            if entry.get('kind') == 'library':
                elf_names.add(app_root + '/resources/compat/kirin990/' + name)
    seen, files, asar_hash, payload_bytes = set(), set(), None, 0
    with tarfile.open(fileobj=io.BytesIO(ar['data.tar.xz']), mode='r|xz',
                      encoding='utf-8', errors='surrogateescape') as archive:
        for index, member in enumerate(archive):
            if index == 0:
                check_root(member)
                continue
            name = safe_name(member.name)
            if name in seen or name not in expected or not (member.isdir() or member.isfile()):
                raise ValueError('Unexpected or linked payload member: ' + name)
            seen.add(name)
            source = expected[name]
            if member.isdir():
                if not source.is_dir():
                    raise ValueError('Directory type mismatch')
                check_owner(member, 0o755)
                continue
            check_owner(member, executable_modes.get(name, 0o644))
            if not source.is_file() or member.size != source.stat().st_size:
                raise ValueError('Payload size mismatch')
            files.add(name)
            payload_bytes += member.size
            sha, md5, prefix = hashlib.sha256(), hashlib.md5(), b''
            payload = archive.extractfile(member)
            for block in iter(lambda: payload.read(1024 * 1024), b''):
                if len(prefix) < 20:
                    prefix += block[:20 - len(prefix)]
                sha.update(block)
                md5.update(block)
            source_sha, source_md5 = digest_file(source)
            if sha.hexdigest() != source_sha or md5.hexdigest() != source_md5 or md5sums.get(name) != source_md5:
                raise ValueError('Payload or md5sums differ from staged bytes: ' + name)
            if name in elf_names and (prefix[:6] != b'\x7fELF\x02\x01' or int.from_bytes(prefix[18:20], 'little') != (62 if arch == 'x64' else 183)):
                raise ValueError('ELF architecture mismatch')
            if name == app_root + '/resources/app.asar':
                asar_hash = source_sha
    if seen != set(expected) or files != set(md5sums) or not asar_hash:
        raise ValueError('Payload inventory is incomplete')
    installed_kib = (payload_bytes + 1023) // 1024
    # Older valid packages omit this optional Debian control field.
    declared_size = fields.get('Installed-Size')
    if declared_size is not None and declared_size.strip() != str(installed_kib):
        raise ValueError('Installed-Size does not match the actual payload')
    return {'passed': True, 'file': str(package.resolve()), 'arch': arch, 'bytes': package.stat().st_size,
            'sha256': digest_file(package)[0], 'asarSha256': asar_hash, 'entries': len(seen),
            'allPayloadBytesMatched': True, 'permissionsVerified': True, 'rootOwnershipVerified': True,
            'gnuTarVerified': True, 'paxHeadersAbsent': True,
            'installedSizeKiB': installed_kib, 'installedSizeDeclared': declared_size is not None,
            'compatibility': compatibility, 'deployment': deployment, 'targetExecuted': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', required=True, type=pathlib.Path)
    parser.add_argument('--stage', required=True, type=pathlib.Path)
    parser.add_argument('--arch', required=True, choices=['x64', 'arm64'])
    parser.add_argument('--version', required=True)
    parser.add_argument('--compatibility', choices=['kirin990'])
    parser.add_argument('--deployment', choices=['huizhou-intranet'])
    args = parser.parse_args()
    print(json.dumps(verify(args.package, args.stage, args.arch, args.version, args.compatibility, args.deployment), ensure_ascii=False))
