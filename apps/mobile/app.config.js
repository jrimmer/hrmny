/**
 * Expo dynamic config over app.json (Expo passes app.json in as `config`).
 *
 * Per-deployment identities stay out of the source: the Apple Developer team
 * that signs the iOS build comes from APPLE_TEAM_ID at prebuild time
 * (scripts/ios-release.sh requires it). Unset — a contributor's simulator or
 * Android build — leaves app.json exactly as committed, which names no team.
 */
module.exports = ({ config }) => {
  const teamId = (process.env.APPLE_TEAM_ID ?? '').trim();
  if (teamId === '') return config;
  return { ...config, ios: { ...config.ios, appleTeamId: teamId } };
};
