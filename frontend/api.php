<?php

declare(strict_types=1);

ini_set('display_errors', '0');
require dirname(__DIR__) . '/backend/Store.php';
require dirname(__DIR__) . '/backend/Files.php';
require dirname(__DIR__) . '/backend/RequestCache.php';
require dirname(__DIR__) . '/backend/HumanFiles.php';
require dirname(__DIR__) . '/backend/JoinFiles.php';
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');
try {
    $config = require dirname(__DIR__) . '/config.php';
    $store = new Store($config['assets_dir'], $config['exhibits_dir']);
    RequestCache::prune();
    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        if (($_GET['action'] ?? '') === 'photo') {
            $a = $store->namedPhoto($_GET['exhibitId'] ?? '', $_GET['file'] ?? '');
            header('Content-Type: ' . $a['mime']);
            header('Content-Security-Policy: default-src \'none\'');
            readfile($a['path']);
            exit;
        }
        if (($_GET['action'] ?? '') === 'asset') {
            $a = $store->asset($_GET['kind'] ?? '', $_GET['id'] ?? '');
            header('Content-Type: ' . $a['mime']);
            header('Content-Security-Policy: default-src \'none\'');
            readfile($a['path']);
            exit;
        }
        $result = ($_GET['action'] ?? '') === 'receipt' ? ['applied' => $store->receipt($_GET['requestId'] ?? '')] : $store->snapshot();
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
        if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 68 * 1024 * 1024) {
            throw new ApiError('fileTooLarge');
        }
        if (str_starts_with($_SERVER['CONTENT_TYPE'] ?? '', 'multipart/form-data') &&
            !$_POST && !$_FILES && (int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) {
            throw new ApiError('uploadLimit', 503);
        }
        if (isset($_POST['payload'])) {
            $payload = json_decode($_POST['payload'], true, 128, JSON_THROW_ON_ERROR);
            if (!is_array($payload) || !in_array($payload['action'] ?? '', ['note', 'correctNote'], true)) {
                throw new ApiError('invalidInput');
            }
            $attachments = $payload['attachments'] ?? [];
            if (!is_array($attachments) || count($attachments) > 8) throw new ApiError('invalidImage');
            $uploads = [];
            $seen = [];
            foreach ($attachments as $attachment) {
                $field = $attachment['field'] ?? '';
                if (!is_string($field) || !preg_match('/^photo_\d+$/', $field) || isset($seen[$field])) {
                    throw new ApiError('invalidImage');
                }
                $seen[$field] = true;
                $file = $_FILES[$field] ?? null;
                if (($file['error'] ?? null) === UPLOAD_ERR_INI_SIZE) throw new ApiError('uploadLimit', 503);
                if (($file['error'] ?? null) === UPLOAD_ERR_FORM_SIZE) throw new ApiError('fileTooLarge');
                if (!$file || $file['error'] !== UPLOAD_ERR_OK || !is_uploaded_file($file['tmp_name'])) {
                    throw new ApiError('invalidUpload');
                }
                $bytes = file_get_contents($file['tmp_name']);
                $info = @getimagesize($file['tmp_name']);
                $mime = (new finfo(FILEINFO_MIME_TYPE))->file($file['tmp_name']);
                if ($bytes === false || strlen($bytes) > 8 * 1024 * 1024 || !$info ||
                    $info[0] > 10000 || $info[1] > 10000 ||
                    !in_array($mime, ['image/jpeg', 'image/png', 'image/webp'], true)) {
                    throw new ApiError('invalidImage');
                }
                $uploads[] = ['requestId' => Store::requestId($attachment['requestId'] ?? null),
                    'bytes' => $bytes, 'mime' => $mime];
            }
            $result = $store->mutate($payload, $uploads);
        } elseif (isset($_FILES['file'])) {
            throw new ApiError(($_POST['kind'] ?? '') === 'model' ? 'assetsReadOnly' : 'invalidInput');
        } else {
            if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 2 * 1024 * 1024) {
                throw new ApiError('fileTooLarge');
            }
            $p = json_decode(file_get_contents('php://input'), true, 128, JSON_THROW_ON_ERROR);
            if (!is_array($p)) {
                throw new ApiError('invalidInput');
            }
            $result = $store->mutate($p);
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
} catch (JsonException $e) {
    http_response_code(422);
    header('Content-Type: application/json');
    echo '{"error":"invalidInput"}';
} catch (Throwable $e) {
    error_log('Hub request failed: ' . get_class($e) . ': ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine());
    http_response_code(503);
    header('Content-Type: application/json');
    echo '{"error":"storage"}';
}
