const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());

app.post('/contact', (req, res) => {
  console.log('Contact form data:', req.body);
  res.status(200).send('Form received!');
});

app.listen(PORT, () => {
  console.log(`Server live on port ${PORT}`);
});
