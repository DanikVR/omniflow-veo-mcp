# Security

## Reporting

Found something that lets a page, an extension or a network peer reach the bridge without the token, read files it should not, or make the extension act outside the Google Flow tab? Please write privately first: **[t.me/GuruAppSheet](https://t.me/GuruAppSheet)**. You will get an answer within two working days, and a fix before any public write-up.

## What the bridge guarantees

- Listens on `127.0.0.1` unless you set `OF_HOST` yourself.
- Off-loopback, every request must carry `x-omniflow-token` matching `~/.omniflow-token` (constant-time comparison).
- Only `chrome-extension://` origins are accepted; browser pages get 403.
- It never executes remote code, never fetches URLs on your behalf, and writes files only under `OF_OUT`.

## What is out of scope

The Google Flow web app and the OmniFlow Chrome extension are not part of this repository. Reports about them are still welcome at the same address.
