# WeWe RSS on Zeabur

This template deploys WeWe RSS with SQLite.

Notes:
- SQLite stores data on `/app/data`; make sure a persistent volume is mounted there in Zeabur.
- Set `AUTH_CODE` if you want to protect the admin API.
- After deployment, set `SERVER_ORIGIN_URL` to your Zeabur domain for absolute feed links.
- `MAX_REQUEST_PER_MINUTE` is optional and defaults to 60.
