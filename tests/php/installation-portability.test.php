<?php

declare(strict_types=1);

require __DIR__ . '/source-fixtures.php';

function portableDataset(string $assets, string $exhibits, array $floors, string $name): string
{
    foreach ($floors as $floor) mkdir($assets . '/Floors/' . $floor, 0775, true);
    $model = 'HardwareModels/' . $name . '.glb';
    $json = testJson(['asset' => ['version' => '2.0'], 'meshes' => [['primitives' => []]]]);
    $json = str_pad($json, (int)(ceil(strlen($json) / 4) * 4), ' ');
    $glb = 'glTF' . pack('V4', 2, 20 + strlen($json), strlen($json), 0x4e4f534a) . $json;
    testWrite($assets . '/' . $model, $glb);
    testWrite($exhibits . '/' . $name . '/.exhibit.json', testJson([
        'floor' => end($floors), 'status' => 'problem', 'models' => [['model' => $model]],
        'lastEditedBy' => 'Synthetic Prüfer Ω'
    ]));
    testWrite($exhibits . '/' . $name . '/Notizen/Tester 01_01_2026 10.00.md', 'Synthetic portable data: Grüße 中文 🧪');
    return $model;
}

function portableRun(string $runner, string $application, string $runtime, string $mode = 'api', string $argument = ''): array
{
    $process = proc_open([
        PHP_BINARY, '-d', 'disable_functions=exec,shell_exec,system,passthru,popen,proc_open',
        $runner, $application, $mode, $argument
    ], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, dirname($runner),
        ['PATH' => '', 'TMPDIR' => $runtime], ['bypass_shell' => true]);
    testCheck(is_resource($process), 'Could not start isolated PHP installation fixture');
    fclose($pipes[0]);
    $output = stream_get_contents($pipes[1]);
    $errors = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $status = proc_close($process);
    testCheck($status === 0 && trim($errors) === '', 'Installed application must run using PHP alone: ' . $errors);
    $result = json_decode($output, true, 128, JSON_THROW_ON_ERROR);
    testCheck(is_array($result) && !isset($result['error']), 'Installed application returned an API error: ' . $output);
    return $result;
}

function portableSourceHashes(string $path): array
{
    $hashes = [];
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS));
    foreach ($iterator as $file) {
        $hashes[substr($file->getPathname(), strlen($path) + 1)] = hash_file('sha256', $file->getPathname());
    }
    ksort($hashes);
    return $hashes;
}

$root = testTemp('installation-portability');
try {
    $application = $root . '/Installation/ArbitraryHubName';
    $runtime = $root . '/Runtime';
    mkdir($application . '/backend', 0775, true);
    mkdir($application . '/frontend', 0775, true);
    mkdir($runtime);
    foreach (glob($testSourceRoot . '/backend/*.php') ?: [] as $file) {
        testCheck(copy($file, $application . '/backend/' . basename($file)), 'Could not copy application source fixture');
    }
    testCheck(copy($testSourceRoot . '/frontend/api.php', $application . '/frontend/api.php'), 'Could not copy API source fixture');
    testCheck(copy($testSourceRoot . '/config.php', $application . '/config.php'), 'Could not copy default configuration fixture');
    $runner = $root . '/run-installed.php';
    testWrite($runner, <<<'PHP'
<?php
declare(strict_types=1);
$application = $argv[1];
$mode = $argv[2];
if ($mode === 'api') {
    $_SERVER['REQUEST_METHOD'] = 'GET';
    $_GET = [];
    require $application . '/frontend/api.php';
    exit;
}
foreach (['Files', 'RequestCache', 'HumanFiles', 'Store', 'JoinFiles'] as $class) {
    require $application . '/backend/' . $class . '.php';
}
$config = require $application . '/config.php';
$store = new Store($config['assets_dir'], $config['exhibits_dir']);
if ($mode === 'asset') {
    $result = $store->asset('model', $argv[3]);
} elseif ($mode === 'create') {
    $snapshot = $store->snapshot();
    $result = $store->mutate([
        'action' => 'structure', 'requestId' => 'portable_create_001', 'signature' => 'Synthetic Tester',
        'baseRevision' => $snapshot['structureRevision'],
        'changes' => [[
            'kind' => 'exhibits', 'op' => 'put', 'id' => 'Création 🧪',
            'record' => ['id' => 'Création 🧪', 'name' => 'Création 🧪', 'floorId' => end($snapshot['floors'])['id'], 'models' => []]
        ]]
    ])['snapshot'];
} else {
    $result = $store->snapshot();
}
echo json_encode($result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
PHP);

    $defaultAssets = dirname($application) . '/Assets';
    $defaultExhibits = dirname($application) . '/Exponate';
    portableDataset($defaultAssets, $defaultExhibits, [-3, 9], 'Default Ω');
    $default = portableRun($runner, $application, $runtime);
    $defaultHashes = [portableSourceHashes($defaultAssets), portableSourceHashes($defaultExhibits)];
    testCheck(array_column($default['floors'], 'id') === ['-3', '9'] && array_column($default['exhibits'], 'id') === ['Default Ω'], 'A source-only application installation must load the configured sibling roots without a floor zero');
    testCheck(!is_dir($application . '/tests') && !is_dir($application . '/tools'), 'Runtime fixture must exclude development and test tooling');

    $customAssets = $root . '/SeparateStorage/模型';
    $customExhibits = $root . '/DifferentStorage/展品';
    $model = portableDataset($customAssets, $customExhibits, [-8, 17], 'Gerät 中文');
    testWrite($application . '/config.php', "<?php\nreturn " . var_export(['assets_dir' => $customAssets, 'exhibits_dir' => $customExhibits], true) . ";\n");
    $sourceHashes = portableSourceHashes($application);
    $custom = portableRun($runner, $application, $runtime);
    testCheck(array_column($custom['floors'], 'id') === ['-8', '17'] && array_column($custom['exhibits'], 'id') === ['Gerät 中文'], 'Arbitrary external root names and locations must replace the default dataset');
    testCheck($custom['datasetKey'] !== $default['datasetKey'], 'Changing configured roots must give the new dataset its own identity');
    testCheck($custom['exhibits'][0]['floorId'] === '17' && $custom['exhibits'][0]['placed'], 'External data must retain its nonzero placement and Unicode model references');
    testCheck($custom['exhibits'][0]['notes'][0]['body'] === 'Synthetic portable data: Grüße 中文 🧪', 'External Unicode content must remain readable through the installed API');
    $asset = portableRun($runner, $application, $runtime, 'asset', $model);
    testCheck($asset['path'] === realpath($customAssets) . '/' . $model && $asset['mime'] === 'model/gltf-binary', 'Model delivery must resolve exclusively inside the configured assets root');

    $created = portableRun($runner, $application, $runtime, 'create');
    testCheck(is_file($customExhibits . '/Création 🧪/.exhibit.json') && count($created['exhibits']) === 2, 'Installed structural saves must write into the external exhibit root');
    testCheck([portableSourceHashes($defaultAssets), portableSourceHashes($defaultExhibits)] === $defaultHashes && portableSourceHashes($application) === $sourceHashes, 'Runtime saves must leave every previous dataset file and application source unchanged');

    $movedApplication = $root . '/RelocatedAgain/Nested/AnotherName';
    mkdir(dirname($movedApplication), 0775, true);
    testCheck(rename($application, $movedApplication), 'Could not relocate the synthetic installation');
    $application = $movedApplication;
    $moved = portableRun($runner, $application, $runtime);
    testCheck($moved === $created && portableSourceHashes($application) === $sourceHashes, 'Relocating only the application must preserve the configured dataset, revisions and source files');

    testCheck(rename($customAssets, $customAssets . '-previous') && rename($customExhibits, $customExhibits . '-previous'), 'Could not replace synthetic roots');
    portableDataset($customAssets, $customExhibits, [28], 'Replacement عربي');
    $replacement = portableRun($runner, $application, $runtime);
    testCheck(array_column($replacement['floors'], 'id') === ['28'] && array_column($replacement['exhibits'], 'id') === ['Replacement عربي'], 'Replacing both external roots must load the new content without references to the former dataset');
    testCheck($replacement['datasetKey'] === $custom['datasetKey'] && $replacement['revision'] !== $custom['revision'], 'Content at the same root locations must refresh while keeping its root-based dataset identity');
    testCheck(portableSourceHashes($application) === $sourceHashes, 'Replacing datasets must not generate or modify application files');
    echo "PHP-only installation relocation and external dataset replacement passed\n";
} finally {
    testRemoveTree($root);
}
