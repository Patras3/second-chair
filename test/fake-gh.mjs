// A scripted stand-in for the gh CLI. Each call must match one script entry, in any order.
export function fakeGh(script) {
  const calls = [];
  const gh = {
    async json(args, input) {
      calls.push({ args, input });
      const hit = script.find((s) => s.match(args, input));
      if (!hit) throw new Error(`unexpected gh call: ${args.join(' ')}`);
      return typeof hit.reply === 'function' ? hit.reply(args, input) : structuredClone(hit.reply);
    },
  };
  return { gh, calls };
}
export const has = (...parts) => (args) => parts.every((p) => args.some((a) => a.includes(p)));
