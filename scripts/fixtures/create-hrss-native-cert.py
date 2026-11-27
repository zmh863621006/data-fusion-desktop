"""Disposable loopback TLS fixture; keys stay in the native test's temporary profile."""
import datetime
import pathlib
import sys
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

directory = pathlib.Path(sys.argv[1]).resolve()
assert directory.name.startswith('fusion-ui-runner-') and directory.is_dir()
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'hrss.gdgov.cn')])
now = datetime.datetime.utcnow()
cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName('hrss.gdgov.cn')]), critical=False)
        .sign(key, hashes.SHA256()))
(directory / 'fixture-cert.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
(directory / 'fixture-key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
