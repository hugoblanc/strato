# {{label}}

A Strato provider, made with `strato provider new {{id}}`.
It already works against the fake answers in `fixtures/sample.json`: check it before changing anything.

```
{{test}}
```

## Files

- `{{entry}}`: the provider.
  Change its descriptor (what the tool is, how a person signs in, which links are its own) and the functions that read the tool's answers.
- `strato-provider.d.ts`: the types of the provider interface and of the exec protocol (`strato provider types` prints it again).
- `fixtures/sample.json`: the fake requests and answers the conformance harness serves, and what it expects back.
  Record your tool's real answers there, without secrets nor anyone's messages.

## Install it

1. Add it to `config.json`:

   ```json
   {{snippet}}
   ```

2. Read the code, then trust it, in your own terminal: `strato provider trust {{id}}`.
   Any later change to this folder needs a new trust.
3. Connect your account: `strato setup --connect {{id}}`.

The full guide, protocol and security notes: `strato provider guide`.
