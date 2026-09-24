<?php

// Copy to local.php and select a data directory outside the public web root.
return [
    'data_dir' => getenv('HUB_DATA_DIR') ?: dirname(__DIR__) . '/runtime',
    'demo' => true,
];
