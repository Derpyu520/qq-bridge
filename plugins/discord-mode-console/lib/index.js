import z from '@deepseek-ai/schemastery';

export const name = 'discord-mode-console';
export const inject = ['settings'];
export const Config = z.object({
  mode: z.union([
    z.const('chat'), z.const('closed-agent'), z.const('reserved'),
    z.const('reserved2'), z.const('simulation'),
  ]).default('reserved2').extra('volatile', true),
  ownerId: z.string().description('Discord owner ID; empty keeps config.json unchanged').extra('volatile', true),
});

// DSH 0.2 settings namespaces come from the loader entry ID and volatile Config.
export function apply() {}
