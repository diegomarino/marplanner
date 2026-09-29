/** A tiny, hardcoded, test-only self-signed TLS cert/key pair (the de-vacuized
 * `tlsInsecure` coverage, tests/integration/network-devices-client-tls.test.ts) — CN=localhost,
 * SAN=DNS:localhost + IP:127.0.0.1, RSA-2048, valid ~100 years (generated once at authoring
 * time via `openssl req -x509 -newkey rsa:2048 -days 36500 -nodes`, never regenerated at test
 * run time — hermetic, no egress, no `openssl` binary dependency in CI).
 * Deliberately self-signed and untrusted by any real CA: `tlsInsecure: false` against a server
 * presenting this cert MUST fail with a TLS trust error (the negative half of the test), and
 * `tlsInsecure: true` MUST succeed despite that (the positive half — the actual behavior under
 * test).
 */
export const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIC9TCCAd2gAwIBAgIUGwrICDvSyEH3l4+YTv2IvS5+xhYwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDkwNTE1MDYxMVoYDzIxMjYw
ODEyMTUwNjExWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDVAzG/F6GOrwhdnlv4hzV74eajn4gZCXdVoq8dyZCD
TmhdhXjM7x7t3mba0fwSNnbIUu5c830Z4WSI7SgVpq0JvnHt/5rQ+8H16PLp0QeU
PGo2kFEKmsXqSN/WFoWZne8WOomt2uXR+S5UdcTJUWe5arCVI1tWiBTEd9D0brNp
0FQ5GH33/7++j1QxgqMoTlQ3Fcs3YN+spcGLu++UbwSGqBJInlUSO0dTW24u6MQS
PKD6juobkh3FAJV0fAGLza9udV+l1qn7gkXbQfIsW4x9UOwIvOrIh/7p5+GvSyr/
uBxqnt/WFJfMxJlagoxJ2UxrUOwOHq0rTKaWrNI4vrZrAgMBAAGjPTA7MBoGA1Ud
EQQTMBGCCWxvY2FsaG9zdIcEfwAAATAdBgNVHQ4EFgQUelYqs4AGy3FgmWoZJEEu
xzLM5OEwDQYJKoZIhvcNAQELBQADggEBAIp8XiRqq6z/hzXCHvnbvL+cQeT57Nf7
++zyFW5F9CcWFeSu3Bg9s0NmP9PcFy0E+CZnYCF7RCy/xqdeb4GIH+DtYoysDOHj
4w1HBH+5s9yRR/1Fujov52KCqMXKMqBiZBSokt3RVMEoXxoxTmiEypNUebXY/GcN
GS8e/wWzGpAXYbfsgHS9yJ6liQ839M9q02olJduBvVDtCoFNw3uiJxCVfg2OdfMK
vKrTiPQuFsvh9F47385iw9sah5IrQa9kROStv1jepSi66ZUvA/mu3L9DIIgNB9Vc
sBtLDOLExBgcXJNG1BAHjA/gl+VqVlXdUE180cs6Zm98QDhxV2mNKCg=
-----END CERTIFICATE-----
`;

export const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDVAzG/F6GOrwhd
nlv4hzV74eajn4gZCXdVoq8dyZCDTmhdhXjM7x7t3mba0fwSNnbIUu5c830Z4WSI
7SgVpq0JvnHt/5rQ+8H16PLp0QeUPGo2kFEKmsXqSN/WFoWZne8WOomt2uXR+S5U
dcTJUWe5arCVI1tWiBTEd9D0brNp0FQ5GH33/7++j1QxgqMoTlQ3Fcs3YN+spcGL
u++UbwSGqBJInlUSO0dTW24u6MQSPKD6juobkh3FAJV0fAGLza9udV+l1qn7gkXb
QfIsW4x9UOwIvOrIh/7p5+GvSyr/uBxqnt/WFJfMxJlagoxJ2UxrUOwOHq0rTKaW
rNI4vrZrAgMBAAECggEAE2MkinTEprS7PrC/RISjM2DGpKV29iG8mPCNyVjDTJLS
KzzkLJwmRQEafG0N6RHISDL1cJlVYrR3JC1C74w0MJsC9JCbOc0dhLEMjDJoYwSy
qBUE2JcTT1+4RlyAvBAPUYccvn7vWZKOixpi7EMlUnoUPfwHVVNdDIVZNn4YL0JK
UHAUo5L55REyFbUVQDIoOtjiR6AQYJP3EU+PjK/FhcYUodnHG0bMbuYeIQ2JVGU0
t4uXDZb2U2uut/AK5iSAB6wnEzJLCVKGdMlOeHdj3yOA5pvcSMFwF6vEAh4mFBfY
FqQNZPGiAUTp0WnJpcapB5bwGPv6qURlruvr9BZ2gQKBgQD/55eqOvxm2cd14VVl
LXicNUAXJ+xBB3VQ2d4MyNm/fsqWK7p/xFW7hfS8U1anl22ZTMM9elEURLxrWGxJ
TuVUd8TxqnNoQGaB8y9zVZMbUtkAH1p9bsl3s84p3PXHwnc7Zqbtnsw0nnc3FPxT
fdhOSdRY4ZQq+xbiUYMmsv+X6wKBgQDVF4LMTLhDXkrpo/72uT7V+JaShsvdfFom
hTDGLfzofW2UYP91x8KF4q3jQaMwykUvqSWyvsROXHcH6bbbfL7jkJ1bLQy86l+B
wZW09iIw5QZk3VsttlEDugmCPG9YQZHt65PqpfBmbruxulCFe1rAC8kj3nK0Q2gB
K/ccTdA7gQKBgQDhdJ2XWa6DwrzLK0I8CKqpHPUhMYgg5rxCBiBurQnCf6dmVJJT
/Jr3wpYS0W2X636gwBOG91u1erVx8Y49q+e52mdF7sEMiSiGtsUIXM1lFkGerQDh
X5jaACzTjxtu6fJ4AAFzeiM4/J/VhISl3kqS9tLBl8Qddef8booYrz0mDwKBgQCv
fRFG1tfZA0qGZ3yOC7jn1jWKrmAuIz7LAl1MmIrznHgl/kvj34MfZ7L0uRWAFNQt
kAtvzRM1xYhxh9QDphQ+rNYqREt9OTc2UQrNYPZ/dd1yK6nvV3oYq5kxHDxGXpmj
aqMCV25HrWH92AaAJzpxdkNLuuKT+f8pF+AF+z9GAQKBgER4lhauDNRYlFNhruuc
aOnTd4fPv6wsuVFM9wDV1vs8vtxHxrZupoCUO+F0zP8vhZGqTB6FVy1CBO7T/F68
mPz0t81qbeW9vNbsFokzkN7QKUOWmenYGz1c25nIuBQ7LXgS9B7GGQK0fTYQPlrx
AEcGna0Ei6+Dbg9Uy+DH8/4C
-----END PRIVATE KEY-----
`;
