# Node.js in WSL

Node is installed via nvm. Always source it before running node/npm:

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"
```

Then `node`, `npm`, `npm run compile` etc. will work.
