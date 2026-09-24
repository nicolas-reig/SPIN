<?php

declare(strict_types=1);

$manifest = json_decode(
    file_get_contents(dirname(__DIR__) . '/public/assets/manifest.json'),
    true,
    512,
    JSON_THROW_ON_ERROR
);
$seed = json_decode(
    file_get_contents(__DIR__ . '/demo.json'),
    true,
    512,
    JSON_THROW_ON_ERROR
);
$seed['assets'] = [];

foreach ($manifest['assets'] as $asset) {
    $seed['assets'][$asset['id']] = $asset;
}

return $seed;
