"""Bounded fixture tests for the portable DEB writer and independent verifier."""
import importlib.util
import hashlib
import io
import json
import lzma
import pathlib
import shutil
import tarfile
import tempfile
import unittest


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


builder = load('kylin_builder', 'build-kylin-deb.py')
verifier = load('kylin_verifier', 'verify-kylin-deb.py')


class PortableDebTests(unittest.TestCase):
    def setUp(self):
        builder.STAGING.mkdir(parents=True, exist_ok=True)
        self.directory = pathlib.Path(tempfile.mkdtemp(prefix='deb-fixture-', dir=str(builder.STAGING))).resolve()
        self.stage = self.directory / 'stage'
        self.stage.mkdir()
        (self.stage / 'DEBIAN').mkdir()
        (self.stage / 'DEBIAN/control').write_text('Package: data-fusion-desktop\nVersion: 1.2.3\nArchitecture: amd64\n', encoding='utf-8')
        binary = bytearray(64)
        binary[:6] = b'\x7fELF\x02\x01'
        binary[18:20] = (62).to_bytes(2, 'little')
        for name in builder.EXECUTABLE_MODES:
            path = self.stage / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(binary)
        (self.stage / 'opt/data-fusion/resources').mkdir()
        (self.stage / 'opt/data-fusion/resources/app.asar').write_bytes(b'fixture asar exact bytes')
        self.output = self.directory / 'package.deb'

    def tearDown(self):
        self.assertEqual(self.directory.parent, builder.STAGING.resolve())
        self.assertTrue(self.directory.name.startswith('deb-fixture-'))
        shutil.rmtree(str(self.directory))

    def test_round_trip_ownership_permissions_and_exact_bytes(self):
        builder.build(self.stage, 'x64', '1.2.3', self.output)
        result = verifier.verify(self.output, self.stage, 'x64', '1.2.3')
        self.assertTrue(result['allPayloadBytesMatched'])
        self.assertTrue(result['gnuTarVerified'])
        self.assertTrue(result['paxHeadersAbsent'])
        first = self.output.read_bytes()
        builder.build(self.stage, 'x64', '1.2.3', self.output)
        self.assertEqual(self.output.read_bytes(), first, 'identical staged content must produce a reproducible DEB')

    def test_uses_kylin_compatible_ar_xz_and_gnu_tar(self):
        builder.build(self.stage, 'x64', '1.2.3', self.output)
        members = verifier.ar_contents(self.output)
        self.assertEqual(list(members), ['debian-binary', 'control.tar.xz', 'data.tar.xz'])
        raw_deb = self.output.read_bytes()
        self.assertEqual(raw_deb[8:24], b'debian-binary   ')
        for name in ('control.tar.xz', 'data.tar.xz'):
            self.assertTrue(members[name].startswith(b'\xfd7zXZ\x00'))
            verifier.check_gnu_tar(members[name])
            raw_tar = lzma.decompress(members[name])
            self.assertEqual(raw_tar[257:265], b'ustar  \0')
            with tarfile.open(fileobj=io.BytesIO(members[name]), mode='r:xz') as archive:
                self.assertEqual(archive.getmembers()[0].name, '.')
                self.assertTrue(archive.getmembers()[0].isdir())

    def test_chinese_and_long_utf8_names_use_compatible_gnu_records(self):
        name = '中文许可' * 10 + '.txt'
        content = '企业名称：测试企业\n许可内容：准予许可。'.encode('utf-8')
        (self.stage / name).write_bytes(content)
        builder.build(self.stage, 'x64', '1.2.3', self.output)
        result = verifier.verify(self.output, self.stage, 'x64', '1.2.3')
        self.assertTrue(result['paxHeadersAbsent'])
        members = verifier.ar_contents(self.output)
        with tarfile.open(fileobj=io.BytesIO(members['data.tar.xz']), mode='r:xz', encoding='utf-8') as archive:
            self.assertEqual(archive.extractfile('./' + name).read(), content)

    def test_verifier_rejects_hidden_pax_headers(self):
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode='w', format=tarfile.PAX_FORMAT, encoding='utf-8') as archive:
            info = builder.tar_info('中文许可.txt', 1)
            archive.addfile(info, io.BytesIO(b'x'))
        # tarfile normally consumes this extension and hides it from callers.
        self.assertEqual(raw.getvalue()[156:157], b'x')
        with self.assertRaisesRegex(ValueError, 'PAX'):
            verifier.check_gnu_tar(lzma.compress(raw.getvalue()))

    def test_verifier_rejects_ar_name_slash_compatibility_regression(self):
        builder.build(self.stage, 'x64', '1.2.3', self.output)
        content = bytearray(self.output.read_bytes())
        content[8:24] = b'debian-binary/  '
        self.output.write_bytes(content)
        with self.assertRaisesRegex(ValueError, 'trailing slash'):
            verifier.ar_contents(self.output)

    def test_rejects_wrong_control_architecture_before_output(self):
        with self.assertRaisesRegex(ValueError, 'Control'):
            builder.build(self.stage, 'arm64', '1.2.3', self.output)
        self.assertFalse(self.output.exists())

    def test_rejects_wrong_elf_architecture(self):
        path = self.stage / 'opt/data-fusion/data-fusion'
        binary = bytearray(path.read_bytes())
        binary[18:20] = (183).to_bytes(2, 'little')
        path.write_bytes(binary)
        with self.assertRaisesRegex(ValueError, 'ELF architecture'):
            builder.build(self.stage, 'x64', '1.2.3', self.output)

    def stage_kirin_fixture(self):
        for name in builder.EXECUTABLE_MODES:
            path = self.stage / name
            content = bytearray(path.read_bytes())
            content[18:20] = (183).to_bytes(2, 'little')
            path.write_bytes(content)
        native = self.stage / 'opt/data-fusion/data-fusion.bin'
        (self.stage / 'opt/data-fusion/data-fusion').rename(native)
        wrapper = self.stage / 'opt/data-fusion/data-fusion'
        wrapper.write_bytes((builder.PROJECT / 'resources/kirin990-launcher.sh').read_bytes().replace(b'\r\n', b'\n'))
        private = self.stage / 'opt/data-fusion/resources/compat/kirin990'
        private.mkdir(parents=True)
        library = private / 'libgbm.so.1'
        library.write_bytes(native.read_bytes())
        sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
        metadata = {'variant': 'kirin990-arm64', 'architecture': 'arm64', 'nativeExecutable': 'data-fusion.bin',
                    'nativeSha256': sha(native), 'launcherSha256': sha(wrapper), 'rendererSandbox': True,
                    'files': [{'path': 'libgbm.so.1', 'sha256': sha(library), 'kind': 'library'}]}
        (private / 'provenance.json').write_text(json.dumps(metadata), encoding='utf-8')
        (self.stage / 'DEBIAN/control').write_text('Package: data-fusion-desktop\nVersion: 1.2.3\nArchitecture: arm64\n', encoding='utf-8')
        return private

    def test_kirin_variant_verifies_wrapper_native_modes_private_bytes_and_arm64(self):
        self.stage_kirin_fixture()
        builder.build(self.stage, 'arm64', '1.2.3', self.output, 'kirin990')
        result = verifier.verify(self.output, self.stage, 'arm64', '1.2.3', 'kirin990')
        self.assertTrue(result['allPayloadBytesMatched'])
        self.assertEqual(result['compatibility'], 'kirin990')
        self.assertFalse(result['targetExecuted'])

    def test_kirin_variant_rejects_changed_private_library_before_packaging(self):
        private = self.stage_kirin_fixture()
        (private / 'libgbm.so.1').write_bytes(b'changed library')
        with self.assertRaisesRegex(ValueError, 'library digest'):
            builder.build(self.stage, 'arm64', '1.2.3', self.output, 'kirin990')
        self.assertFalse(self.output.exists())

    def test_kirin_wrapper_cannot_be_built_or_verified_as_normal_arm64(self):
        self.stage_kirin_fixture()
        with self.assertRaisesRegex(ValueError, 'ELF architecture'):
            builder.build(self.stage, 'arm64', '1.2.3', self.output)
        with self.assertRaises(ValueError):
            builder.build(self.stage, 'x64', '1.2.3', self.output, 'kirin990')
        self.assertFalse(self.output.exists())

    def test_does_not_include_maintainer_scripts(self):
        (self.stage / 'DEBIAN/postinst').write_text('must never run', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'maintainer scripts'):
            builder.build(self.stage, 'x64', '1.2.3', self.output)

    def test_verifier_detects_changed_staged_content(self):
        builder.build(self.stage, 'x64', '1.2.3', self.output)
        (self.stage / 'opt/data-fusion/resources/app.asar').write_bytes(b'changed staging bytes')
        with self.assertRaises(ValueError):
            verifier.verify(self.output, self.stage, 'x64', '1.2.3')

    def test_rejects_linked_paths(self):
        link = self.stage / 'outside-link'
        try:
            link.symlink_to(self.directory, target_is_directory=True)
        except OSError as error:
            self.skipTest('This Windows account cannot create test symlinks: ' + str(error))
        with self.assertRaisesRegex(ValueError, 'Linked'):
            builder.build(self.stage, 'x64', '1.2.3', self.output)


if __name__ == '__main__':
    unittest.main()
