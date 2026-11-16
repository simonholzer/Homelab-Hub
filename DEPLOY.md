# Deploy to TrueNAS

## The easy way: the published image

In TrueNAS: **Apps → Discover Apps → ⋮ → Install via YAML**, name **`homelab-hub`**, paste [compose.yaml](compose.yaml)
unchanged and save. Open `http://<nas>:8080` and follow the three steps on the page.

Things you may want to change in the YAML (Apps → homelab-hub → **Edit**):

- the port, if 8080 is taken (e.g. `"30082:8080"`)
- one mount line per pool for the storage tiles, e.g. `- /mnt/tank:/pools/tank:ro`
- `hub-config:/config` → a dataset path such as `/mnt/tank/appdata/homelab-hub:/config`, if you want the config as
  files in a dataset (for snapshots and replication) instead of in a Docker volume. The container fixes the owner of
  that folder by itself. Do this before you set things up: a new folder starts with an empty config. To update, pull the
new image in the app's menu. To stay on one version, write it instead of `latest` in the image line (e.g. `:1.3.0`).

To show the stats of other machines too, run [compose.agent.yaml](compose.agent.yaml) on them (README, "Stats from
other machines"). On a second TrueNAS box that is another custom app with that file. The rest of this page is only needed for the other way.

## The other way: build the image on the NAS

Useful when you change the code yourself, or don't want to pull an image from a registry.
The image is built on the NAS from the last git commit, and the app is installed once via YAML.

The first start copies the small starter config. To begin with the full example instead, run the build script
once with `--replace-config` (see below).

The examples below use these placeholders. Replace them with your own:

| Placeholder | Meaning |
|---|---|
| `nas` | SSH host alias of the NAS (an entry in `~/.ssh/config`), or `user@192.168.1.10` |
| `192.168.1.10` | LAN address of the NAS |
| `30082` | Port the hub is published on (any free port) |
| `tank` | Pool that holds the config folder (`/mnt/tank/appdata/homelab-hub`) |
| `hub.example.com` | Public address, if you put the hub behind a Cloudflare Tunnel |

If your pool has another name, change it in [compose.truenas.yaml](compose.truenas.yaml) and in `DATA_DIR` at the top of
[scripts/nas-build.sh](scripts/nas-build.sh) (or pass `DATA_DIR=/mnt/yourpool/appdata/homelab-hub` to the script).

### First install

```bash
git status                                   # commit everything first: the NAS gets the last commit
bash scripts/deploy-copy.sh                  # another host: HOST=user@192.168.1.10 bash scripts/deploy-copy.sh
ssh -t nas "sudo bash ~/homelab-hub/scripts/nas-build.sh"
```

Then in TrueNAS: **Apps → Discover Apps → ⋮ → Install via YAML**, name **`homelab-hub`** (lowercase, digits and `-` only),
paste [compose.truenas.yaml](compose.truenas.yaml), Save. Open `http://192.168.1.10:30082`.

## Check on the NAS

1. **Page loads**, the stats tiles show CPU / memory / load / uptime / storage free.
2. **Container health** shows on the cards of the group with `autoContainers: true`. If a card says *no container found*,
   open `http://192.168.1.10:30082/api/containers`, copy the real name/project, and adjust `containers:` in the YAML.
3. **Memory** looks sensible (used is well below total; "+ x GB ZFS cache" is shown). **Storage free** matches TrueNAS' pool free space.
4. **Cards of other machines** stay red although the machine is up: the hub checks from inside its container on the NAS, so the
   address must be reachable from there. From the NAS shell try `curl -m 4 http://192.168.1.20:9090`. A service that listens
   only on the other machine's `localhost`, or an address on a VPN the container can't reach, will always look offline.
5. **Home detection** (only with a Cloudflare Tunnel): open `hub.example.com` from a device at home. The button at the top
   should say "Home network · auto" and the cards should open their `local:` addresses. If it says "Away", the status JSON
   (`/api/status`, field `client`) shows both public IPs: add yours under `settings.home.publicIps`.
   Opened on `http://192.168.1.10:30082` it must always say home.
6. TrueNAS refusing the `/proc` or `/sys` mounts or the docker-proxy: remove those lines from the YAML; the page then just
   hides the stats / container health.

## Editing the config on the NAS

The easiest way is the editor on the page (gear menu → **Edit services and settings**). By hand: the config folder is owned by the apps
user (568) and is not readable by a normal admin user over plain SSH or SMB, so edit it with sudo:

```bash
ssh -t nas "sudo nano /mnt/tank/appdata/homelab-hub/services.yaml"
```

Save and wait about 30 s.
**The NAS copy is the source of truth after the first start.** Redeploying never overwrites it, so later changes to
`config/services.yaml` in this project do not reach the NAS.

When an update changes `compose.truenas.yaml` (new mounts), the running app must be edited too: TrueNAS → Apps →
homelab-hub → **Edit** (the "Custom Config" box holds the YAML). To replace the NAS config with this project's
`config/services.yaml`, run

```bash
ssh -t nas "sudo bash ~/homelab-hub/scripts/nas-build.sh --replace-config"
```

after the copy step: it builds the image **and** replaces the config (the old one is kept as `services.yaml.bak`).

## Cloudflare Tunnel (optional)

To reach the hub from outside, either set `HUB_PASSWORD` (see the README) or put it behind a
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) with a
Cloudflare Access application in front:

1. Cloudflare One → Access → Applications → add a self-hosted application for `hub.example.com` with a policy that
   lets in only the people you want (e.g. your own email address). **Do this first**, so the hub is never public without a login.
2. Cloudflare One → Networks → Tunnels → your tunnel → add a public hostname: `hub.example.com` → `http://192.168.1.10:30082`.
   The DNS record is normally created automatically. If the hostname already has a DNS record, edit that record to
   point at the tunnel instead.

## Update

```bash
git commit -am "describe the change"
bash scripts/deploy-copy.sh
ssh -t nas "sudo bash ~/homelab-hub/scripts/nas-build.sh"
```

Then TrueNAS → Apps → homelab-hub → **Restart**. Config-only changes need none of this.

## Troubleshooting

| Problem | Fix |
|---|---|
| Install fails: invalid app name | Name must be lowercase letters, digits, `-` |
| `pull access denied for homelab-hub` | The image isn't built yet: run the two commands above first |
| Page shows a red "Config problem" box | The YAML has a mistake; the box says which line/field. The old config keeps running |
| All Docker health shows `containers: ?` | Footer → containers JSON shows the error; usually the docker-proxy container isn't running |
| Page says "Your Cloudflare login has expired" | Click **Log in again** |
