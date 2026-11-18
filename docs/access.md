# Login, home network and proxies

[← Back to the README](../README.md)

## Password login (optional)

Without a password, anyone who can reach the port can see the page and edit the config. That is fine on a home
network you trust. For anything else, set a password or put a login proxy (Cloudflare Access, Authelia, Authentik, a
VPN …) in front.

**On the page:** gear menu → **Set a password**. Choose whether it protects the whole page or only the editor. It can
be changed or removed in the same place. It is stored as a salted hash in `hub-auth.json` next to the config; if you
forget it, delete that file on the server.

**In the compose file,** if you prefer it fixed there (it then can't be changed on the page):

| Variable | Meaning |
|---|---|
| `HUB_PASSWORD` | The password. Unset or empty = no fixed password |
| `HUB_PASSWORD_PROTECTS` | `all` (default): the whole page needs the login. `editor`: everyone sees the page, only the config editor needs it |

The login lasts 30 days per browser; changing the password logs everyone out. Five wrong passwords lock that address
for a minute. Use HTTPS (a reverse proxy) when the hub is reachable from outside your home network: over plain HTTP the
password travels unencrypted.

## Home network: local addresses

Give a service a `local:` address and its card opens that address when you are on the home network.
A service with only `local:` is shown greyed out as "home network only" when you are away.

The hub decides per visit, on the server:

1. Opened **directly on the LAN** (`http://192.168.1.10:8080`) = home.
2. Opened **through a proxy or tunnel** = home when your address is a private one (a proxy on your LAN), or when your
   public IP is the server's public IP or one of `settings.home.publicIps`.
3. Otherwise away. The button at the top (**Home network / Away · auto**) switches Auto → Home → Away and remembers
   the choice in that browser.

For rule 2 the hub must learn the visitor's address from the proxy. Cloudflare's header is understood out of the box;
for another proxy (Caddy, Traefik, Nginx Proxy Manager …) name its header:

```yaml
settings:
  home:
    clientIpHeader: x-forwarded-for     # or x-real-ip
    publicIps: []                       # extra public IPs that count as home (a second internet line, a VPN)
    runsAtHome: true                    # false for a preview on a computer somewhere else
```

The setting only decides which links the cards show. It is not a security feature.

## Behind a login proxy

Services behind a login proxy answer with the login page even when the service itself is dead, so checking their public
address says nothing. The hub shows such a check as a grey **Unknown** dot instead of a false green one: for Cloudflare
Access automatically, for your own login page when you list its host name:

```yaml
settings:
  loginHosts: [auth.example.com]        # Authelia, Authentik, Keycloak ...
```

The fix is always the same: point `check:` at the service itself (server IP and port).
