# Box setup (heatmap.teja.software)

Run as root on the box. Each step is safe to repeat.

## nginx: gzip, collect rate limit

```bash
install -m 644 deploy/nginx/clarity.conf /etc/nginx/conf.d/clarity.conf
patch /etc/nginx/sites-available/heatmap.teja.software < deploy/nginx/heatmap.teja.software.diff
nginx -t && systemctl reload nginx
```

Check: `curl -sI -H 'Accept-Encoding: gzip' https://heatmap.teja.software/tracker.js` shows `Content-Encoding: gzip`, `Cache-Control: no-cache` and an `ETag`.

## Nightly backup to Garage S3

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
