<?php

return [
    'data_dir' => getenv('WEBAPP_STORAGE_DIR') ?: dirname(__DIR__) . '/storage',
    'content_dir' => getenv('HUB_CONTENT_DIR') ?: dirname(__DIR__, 2),
    'demo' => true,
];
