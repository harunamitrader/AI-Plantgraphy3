'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

async function persistObservationImages({ inputFiles, imagesDir, observationId }) {
  fs.mkdirSync(imagesDir, { recursive: true });
  const saved = [];
  for (const [index, file] of inputFiles.entries()) {
    const filename = `${observationId}-${index + 1}.jpg`;
    const absolutePath = path.join(imagesDir, filename);
    await sharp(file.absolutePath)
      .rotate()
      .resize({
        width: 1280,
        height: 1280,
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({
        quality: 78,
        mozjpeg: true
      })
      .toFile(absolutePath);
    saved.push({
      index: index + 1,
      absolutePath,
      relativePath: toPosixPath(path.join('images', filename))
    });
  }
  return saved;
}

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

module.exports = {
  persistObservationImages
};
