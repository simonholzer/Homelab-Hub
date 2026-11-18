// Ready-made widgets for well-known services. The editor offers one when a card looks like the service
// (its icon, name or container patterns): one click copies it into widgets.yaml, then only the key is
// missing ({env:...} in the hub's compose.yaml). They are ordinary widgets after that: change them freely.
//
// To add one: an entry below with the API path, the header the service wants its key in, and the values.
// `match` are words looked for in the card's icon, name and containers.

export const WIDGET_TEMPLATES = [
  {
    id: 'immich',
    name: 'Immich',
    match: ['immich'],
    env: 'IMMICH_API_KEY',
    help: 'Immich: Account Settings → API Keys. The statistics need an admin\'s key.',
    widget: {
      path: '/api/server/statistics',
      headers: { 'x-api-key': '{env:IMMICH_API_KEY}' },
      fields: [
        { label: 'Photos', value: 'photos', format: 'number' },
        { label: 'Videos', value: 'videos', format: 'number' },
        { label: 'Storage', value: 'usage', format: 'bytes' }
      ]
    }
  },
  {
    id: 'jellyfin',
    name: 'Jellyfin',
    match: ['jellyfin'],
    env: 'JELLYFIN_API_KEY',
    help: 'Jellyfin: Dashboard → API Keys.',
    widget: {
      path: '/Sessions?activeWithinSeconds=600',
      headers: { authorization: 'MediaBrowser Token="{env:JELLYFIN_API_KEY}"' },
      fields: [
        { label: 'Streaming', value: 'count(*.NowPlayingItem)' },
        { label: 'Active', value: 'count(.)' }
      ]
    }
  },
  {
    id: 'portainer',
    name: 'Portainer',
    match: ['portainer'],
    env: 'PORTAINER_API_KEY',
    help: 'Portainer: My account → Access tokens.',
    widget: {
      path: '/api/endpoints',
      insecure: true,
      headers: { 'x-api-key': '{env:PORTAINER_API_KEY}' },
      fields: [
        { label: 'Running', value: 'sum(*.Snapshots.0.RunningContainerCount)' },
        { label: 'Stopped', value: 'sum(*.Snapshots.0.StoppedContainerCount)' },
        { label: 'Environments', value: 'count(.)' }
      ]
    }
  },
  {
    id: 'sonarr',
    name: 'Sonarr',
    match: ['sonarr'],
    env: 'SONARR_API_KEY',
    help: 'Sonarr: Settings → General → API Key.',
    widget: { path: '/api/v3/queue', headers: { 'x-api-key': '{env:SONARR_API_KEY}' }, fields: [{ label: 'In the queue', value: 'totalRecords' }] }
  },
  {
    id: 'radarr',
    name: 'Radarr',
    match: ['radarr'],
    env: 'RADARR_API_KEY',
    help: 'Radarr: Settings → General → API Key.',
    widget: { path: '/api/v3/queue', headers: { 'x-api-key': '{env:RADARR_API_KEY}' }, fields: [{ label: 'In the queue', value: 'totalRecords' }] }
  },
  {
    id: 'lidarr',
    name: 'Lidarr',
    match: ['lidarr'],
    env: 'LIDARR_API_KEY',
    help: 'Lidarr: Settings → General → API Key.',
    widget: { path: '/api/v1/queue', headers: { 'x-api-key': '{env:LIDARR_API_KEY}' }, fields: [{ label: 'In the queue', value: 'totalRecords' }] }
  },
  {
    id: 'prowlarr',
    name: 'Prowlarr',
    match: ['prowlarr'],
    env: 'PROWLARR_API_KEY',
    help: 'Prowlarr: Settings → General → API Key.',
    widget: { path: '/api/v1/indexer', headers: { 'x-api-key': '{env:PROWLARR_API_KEY}' }, fields: [{ label: 'Indexers', value: 'count(.)' }] }
  },
  {
    id: 'jellyseerr',
    name: 'Jellyseerr / Overseerr',
    match: ['jellyseerr', 'overseerr'],
    env: 'JELLYSEERR_API_KEY',
    help: 'Jellyseerr / Overseerr: Settings → General → API Key.',
    widget: {
      path: '/api/v1/request/count',
      headers: { 'x-api-key': '{env:JELLYSEERR_API_KEY}' },
      fields: [
        { label: 'Pending', value: 'pending' },
        { label: 'Requests', value: 'total' }
      ]
    }
  },
  {
    id: 'home-assistant',
    name: 'Home Assistant',
    match: ['home-assistant', 'homeassistant'],
    env: 'HOME_ASSISTANT_TOKEN',
    help: 'Home Assistant: your profile → Security → Long-lived access tokens.',
    widget: { path: '/api/states', headers: { authorization: 'Bearer {env:HOME_ASSISTANT_TOKEN}' }, fields: [{ label: 'Entities', value: 'count(.)' }] }
  },
  {
    id: 'paperless',
    name: 'Paperless-ngx',
    match: ['paperless'],
    env: 'PAPERLESS_TOKEN',
    help: 'Paperless-ngx: My profile → API Auth Token.',
    widget: {
      path: '/api/statistics/',
      headers: { authorization: 'Token {env:PAPERLESS_TOKEN}' },
      fields: [
        { label: 'Documents', value: 'documents_total', format: 'number' },
        { label: 'Inbox', value: 'documents_inbox' }
      ]
    }
  },
  {
    id: 'nextcloud',
    name: 'Nextcloud',
    match: ['nextcloud'],
    env: 'NEXTCLOUD_TOKEN',
    help: 'Nextcloud: set a token with  occ config:app:set serverinfo token --value <token>.',
    widget: {
      path: '/ocs/v2.php/apps/serverinfo/api/v1/info?format=json',
      headers: { 'nc-token': '{env:NEXTCLOUD_TOKEN}' },
      fields: [
        { label: 'Files', value: 'ocs.data.nextcloud.storage.num_files', format: 'number' },
        { label: 'Active today', value: 'ocs.data.activeUsers.last24hours' }
      ]
    }
  },
  {
    id: 'syncthing',
    name: 'Syncthing',
    match: ['syncthing'],
    env: 'SYNCTHING_API_KEY',
    help: 'Syncthing: Actions → Settings → General → API Key.',
    widget: {
      path: '/rest/system/connections',
      headers: { 'x-api-key': '{env:SYNCTHING_API_KEY}' },
      fields: [
        { label: 'Devices', value: 'count(connections)' },
        { label: 'Received', value: 'total.inBytesTotal', format: 'bytes' }
      ]
    }
  },
  {
    id: 'proxmox',
    name: 'Proxmox VE',
    match: ['proxmox', 'pve'],
    env: 'PROXMOX_TOKEN',
    help: 'Proxmox: Datacenter → Permissions → API Tokens. Write it as user@pam!name=secret.',
    widget: {
      path: '/api2/json/cluster/resources',
      insecure: true,
      headers: { authorization: 'PVEAPIToken={env:PROXMOX_TOKEN}' },
      fields: [
        { label: 'VMs and containers', value: 'count(data.*.vmid)' },
        { label: 'Nodes', value: 'count(data.*.node)' }
      ]
    }
  }
];

const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * The template that fits a card, or null: its icon, name and container patterns are searched for the
 * template's words ("Home Assistant", icon home-assistant and *homeassistant* all find home-assistant).
 */
export function templateFor(svc, templates = WIDGET_TEMPLATES) {
  const texts = [svc?.icon, svc?.name, ...(Array.isArray(svc?.containers) ? svc.containers : [svc?.containers])].map(norm).filter(Boolean);
  return templates.find((t) => t.match.some((word) => texts.some((x) => x.includes(norm(word))))) ?? null;
}

/** The templates as the editor gets them: whether each one's key is already set on the hub (never the key). */
export function templatesForEditor(env = process.env) {
  return WIDGET_TEMPLATES.map((t) => ({ ...t, keySet: env[t.env] != null && env[t.env] !== '' }));
}
