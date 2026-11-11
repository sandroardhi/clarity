# Box setup (heatmap.teja.software)

## Releases

Run from a dev machine at the repo root. It needs ssh as root to the box (`CLARITY_HOST`, `CLARITY_SSH_KEY`).

```bash
deploy/deploy.sh release    # build HEAD here, ship to /opt/clarity/releases/<sha>, switch, restart
deploy/deploy.sh rollback   # back to the previous release
deploy/deploy.sh list
```

- `/opt/clarity/current` links to the live release. `/opt/clarity/previous` names the rollback target.
- Each release carries `deploy/systemd/clarity-server.service`. A switch installs it when it differs.
- After the restart the script polls `http://127.0.0.1:$PORT/health` for 30 s. On failure it rolls back and exits 1.
- The unit runs `dist/migrate.js` before start. Migrations only add, so an older release runs on a newer schema.
- The newest 5 releases are kept, plus current and previous.
- First release: the old checkout `/opt/clarity/app` becomes the release `legacy`. Delete `app/` and `releases/legacy` once you no longer need that rollback.

## One-time box steps

Run as root on the box. Each step is safe to repeat.

### nginx: gzip, collect rate limit

```bash
install -m 644 deploy/nginx/clarity.conf /etc/nginx/conf.d/clarity.conf
patch /etc/nginx/sites-available/heatmap.teja.software < deploy/nginx/heatmap.teja.software.diff
nginx -t && systemctl reload nginx
```

Check: `curl -sI -H 'Accept-Encoding: gzip' https://heatmap.teja.software/tracker.js` shows `Content-Encoding: gzip`, `Cache-Control: no-cache` and an `ETag`.

### Nightly backup to Garage S3

Needs rclone and `/etc/clarity-backup.env` (root:root 0600). The script only gets the values through systemd.

```bash
apt-get install -y rclone
install -m 755 deploy/backup/clarity-backup.sh /usr/local/bin/clarity-backup
install -m 644 deploy/backup/clarity-backup.service deploy/backup/clarity-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl start clarity-backup.service && journalctl -u clarity-backup.service -n 5 --no-pager
systemctl enable --now clarity-backup.timer
```

Dumps go to `daily/clarity-YYYY-MM-DD.dump`, and on Sundays also to `weekly/`. The script keeps the newest 14 daily and 8 weekly dumps.

Restore: `pg_restore --clean --if-exists -d clarity clarity-YYYY-MM-DD.dump`.
