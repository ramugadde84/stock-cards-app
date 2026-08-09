console.error("STEP 1: starting requires");
const express = require('express');
console.error("STEP 2: express required");
const path = require('path');
console.error("STEP 3: path required");

const app = express();
console.error("STEP 4: app created");
const PORT = process.env.PORT || 3000;
console.error("STEP 5: PORT=" + PORT);

app.use(express.static(path.join(__dirname, 'public')));
console.error("STEP 6: static middleware set");

app.get('/ping', (req,res) => res.send('pong'));
console.error("STEP 7: route set");

app.listen(PORT, () => {
  console.error("STEP 8: LISTENING on " + PORT);
});
console.error("STEP 9: after app.listen call (sync part done)");
