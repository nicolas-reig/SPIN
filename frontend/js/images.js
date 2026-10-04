export function fileData(file, type = file.type) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(Error('invalidUpload'));
        reader.readAsDataURL(new Blob([file], { type }));
    });
}

export async function readNoteImage(file) {
    if (!file.size) throw Error('invalidImage');
    if (file.size > 8 * 1024 * 1024) throw Error('fileTooLarge');
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const matches = (values, offset = 0) => values.every((value, index) => bytes[offset + index] === value);
    const mime = matches([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ? 'image/png'
        : matches([0xff, 0xd8, 0xff]) ? 'image/jpeg'
        : matches([0x52, 0x49, 0x46, 0x46]) && matches([0x57, 0x45, 0x42, 0x50], 8) ? 'image/webp'
        : null;
    if (!mime) throw Error('invalidImage');
    const data = await fileData(file, mime);
    const image = new Image();
    image.src = data;
    try {
        await image.decode();
    } catch {
        throw Error('invalidImage');
    }
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 10000 || image.naturalHeight > 10000) throw Error('invalidImage');
    return { name: file.name || 'photo', data };
}
