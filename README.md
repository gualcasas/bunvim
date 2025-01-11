# nvim-node

<img src="docs/nvim.svg" height="60px" align="right" />

nvim-node is a port of [bunvim](https://github.com/wallpants/bunvim) to node.

I really like the minimalist approach taken by bunvim relative to [neovim node-client](https://github.com/neovim/node-client). I appreciate the stronger types and closer-to-the-metal, minimalist approach. It feels more like using a query-builder rather than an ORM.

However, I decided to leave bun for now since it has relatively poor support for [async stack traces](https://github.com/oven-sh/bun/issues/2704) and debugging (stepping through async calls).
