// Discord MessageFlags as raw numeric values. The `MessageFlags` enum exported
// from discord.js / discord-api-types fails to narrow to `number` when used in
// `flags: MessageFlags.Ephemeral`, even though the v14 docs prescribe exactly
// that pattern. The workaround is to pass the literal bit instead.
//
// Reference: https://discord.com/developers/docs/resources/channel#message-object-message-flags
export const MSG_FLAG_EPHEMERAL = 1 << 6 // 64
