<?php

declare(strict_types=1);

header('Cache-Control: no-store');
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    http_response_code(405);
    exit;
}
// Require the app's non-simple request and reject cross-origin browser requests.
if (($_SERVER['HTTP_X_HUB_REQUEST'] ?? '') !== '1' ||
    ($_SERVER['HTTP_SEC_FETCH_SITE'] ?? 'same-origin') !== 'same-origin') {
    http_response_code(403);
    exit;
}
header('Clear-Site-Data: "cache", "cookies", "storage"');
http_response_code(204);
