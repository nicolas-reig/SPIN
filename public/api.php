<?php

declare(strict_types=1);

require dirname(__DIR__) . '/server/Store.php';
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');
try {
    $configFile = dirname(__DIR__) . '/config/local.php';
    $config = is_file($configFile) ? require $configFile : require dirname(__DIR__) . '/config/example.php';
    $seed = require dirname(__DIR__) . '/server/seed.php';
    if (!($config['demo'] ?? false)) {
        $seed = ['floors' => [],'exhibits' => [],'assets' => $seed['assets']];
    }
    $store = new Store($config['data_dir'], $seed);
    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        if (($_GET['action'] ?? '') === 'asset') {
            $a = $store->asset($_GET['kind'] ?? '', $_GET['id'] ?? '');
            header('Content-Type: ' . $a['mime']);
            header('Content-Security-Policy: default-src \'none\'');
            readfile($a['path']);
            exit;
        }
        $result = $store->snapshot();
    } elseif ($_SERVER['REQUEST_METHOD'] === 'POST') {
        if (($_SERVER['HTTP_X_HUB_REQUEST'] ?? '') !== '1') {
            throw new ApiError('invalidRequest', 403);
        }
        if (isset($_SERVER['HTTP_ORIGIN'])) {
            $o = parse_url($_SERVER['HTTP_ORIGIN']);
            $host = ($o['host'] ?? '') . (isset($o['port']) ? ':' . $o['port'] : '');
            if ($host !== ($_SERVER['HTTP_HOST'] ?? '')) {
                throw new ApiError('invalidRequest', 403);
            }
        }
        if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 34 * 1024 * 1024) {
            throw new ApiError('fileTooLarge');
        }
        if (isset($_FILES['file'])) {
            if ($_FILES['file']['error'] !== UPLOAD_ERR_OK || !is_uploaded_file($_FILES['file']['tmp_name'])) {
                throw new ApiError('invalidUpload');
            }$result = $store->upload($_POST, $_FILES['file']['tmp_name']);
        } else {
            if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 2 * 1024 * 1024) {
                throw new ApiError('fileTooLarge');
            }$p = json_decode(file_get_contents('php://input'), true, 128, JSON_THROW_ON_ERROR);
            if (!is_array($p)) {
                throw new ApiError('invalidInput');
            }$result = $store->mutate($p);
        }
    } else {
        throw new ApiError('invalidRequest', 405);
    }
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
} catch (ApiError $e) {
    http_response_code($e->status);
    header('Content-Type: application/json');
    echo json_encode(['error' => $e->key,'details' => $e->details]);
} catch (Throwable $e) {
    error_log('Hub request failed: ' . get_class($e));
    http_response_code(503);
    header('Content-Type: application/json');
    echo '{"error":"storage"}';
}
