// Tests never touch the network. Code that calls GitHub gets a fake fetch passed in; anything
// that reaches the real one fails loudly instead.
globalThis.fetch = () =>
  Promise.reject(new Error('Tests must not use the network: pass a fake fetch instead.'));
