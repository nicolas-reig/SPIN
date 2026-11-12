"""Small deterministic GLB fixtures with no external buffers, images or dependencies."""
from __future__ import annotations
import json
import math
import random
import struct


class GLB:
    def __init__(self):
        self.binary = bytearray()
        self.document = {'asset': {'version': '2.0', 'generator': 'digitaltwin-visual-fixture-v1'},
                         'scene': 0, 'scenes': [{'nodes': []}], 'nodes': [], 'meshes': [],
                         'buffers': [{'byteLength': 0}], 'bufferViews': [], 'accessors': [],
                         'materials': [{'pbrMetallicRoughness': {'baseColorFactor': [.7, .6, .4, 1],
                                                               'metallicFactor': 0, 'roughnessFactor': 1}}]}

    def accessor(self, values, width, component=5126, *, bounds=False):
        while len(self.binary) % 4:
            self.binary.append(0)
        start = len(self.binary)
        code = {5126: 'f', 5123: 'H'}[component]
        flat = [item for row in values for item in row] if width > 1 else values
        self.binary.extend(struct.pack('<' + code * len(flat), *flat))
        view = len(self.document['bufferViews'])
        self.document['bufferViews'].append({'buffer': 0, 'byteOffset': start, 'byteLength': len(self.binary) - start})
        result = {'bufferView': view, 'componentType': component, 'count': len(values),
                  'type': {1: 'SCALAR', 3: 'VEC3', 4: 'VEC4', 16: 'MAT4'}[width]}
        if bounds:
            result['min'] = [min(row[i] for row in values) for i in range(width)]
            result['max'] = [max(row[i] for row in values) for i in range(width)]
        self.document['accessors'].append(result)
        return len(self.document['accessors']) - 1

    def mesh(self, positions, faces, *, indexed=True, skin=False, open_surface=False):
        # Distinct vertices per face give both indexed/non-indexed inputs honest hard normals.
        vertices, normals, indices = [], [], []
        for face in faces:
            a, b, c = (positions[i] for i in face)
            u, v = ([b[i] - a[i] for i in range(3)], [c[i] - a[i] for i in range(3)])
            normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
            length = math.sqrt(sum(value * value for value in normal))
            normal = [value / length for value in normal]
            for point in (a, b, c):
                indices.append(len(vertices)); vertices.append(point); normals.append(normal)
        attributes = {'POSITION': self.accessor(vertices, 3, bounds=True), 'NORMAL': self.accessor(normals, 3)}
        if skin:
            attributes['JOINTS_0'] = self.accessor([[0, 0, 0, 0]] * len(vertices), 4, 5123)
            attributes['WEIGHTS_0'] = self.accessor([[1, 0, 0, 0]] * len(vertices), 4)
        primitive = {'attributes': attributes, 'mode': 4, 'material': 0}
        if indexed:
            primitive['indices'] = self.accessor(indices, 1, 5123)
        self.document['meshes'].append({'primitives': [primitive], 'extras': {'openSurface': open_surface}})
        return len(self.document['meshes']) - 1

    def node(self, value, *, root=True):
        self.document['nodes'].append(value)
        index = len(self.document['nodes']) - 1
        if root:
            self.document['scenes'][0]['nodes'].append(index)
        return index

    def bytes(self):
        self.document['buffers'][0]['byteLength'] = len(self.binary)
        document = json.dumps(self.document, sort_keys=True, separators=(',', ':')).encode()
        document += b' ' * (-len(document) % 4)
        binary = bytes(self.binary) + b'\0' * (-len(self.binary) % 4)
        size = 12 + 8 + len(document) + 8 + len(binary)
        return (struct.pack('<III', 0x46546C67, 2, size) + struct.pack('<II', len(document), 0x4E4F534A) + document
                + struct.pack('<II', len(binary), 0x004E4942) + binary)


BOX_FACES = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4),
             (3, 7, 6), (3, 6, 2), (0, 4, 7), (0, 7, 3), (1, 2, 6), (1, 6, 5)]


def box(width, height, depth):
    return [[-width / 2, 0, -depth / 2], [width / 2, 0, -depth / 2],
            [width / 2, height, -depth / 2], [-width / 2, height, -depth / 2],
            [-width / 2, 0, depth / 2], [width / 2, 0, depth / 2],
            [width / 2, height, depth / 2], [-width / 2, height, depth / 2]]


def floor_glb(seed, width, depth):
    rng, model = random.Random(seed), GLB()
    height, wall = min(width, depth) * .18, min(width, depth) * .025
    # Shared wall meshes and a mirrored nested node exercise transform-aware projection.
    slab = model.mesh(box(width, wall, depth), BOX_FACES)
    long_wall = model.mesh(box(width, height, wall), BOX_FACES)
    short_wall = model.mesh(box(wall, height, depth), BOX_FACES, indexed=False)
    model.node({'name': 'slab', 'mesh': slab, 'translation': [0, -wall, 0]})
    for sign in (-1, 1):
        model.node({'mesh': long_wall, 'translation': [0, 0, sign * depth / 2]})
        model.node({'mesh': short_wall, 'translation': [sign * width / 2, 0, 0]})
    child = model.node({'mesh': long_wall, 'scale': [-rng.uniform(.2, .45), .75, 1]}, root=False)
    model.node({'name': 'nested mirrored partition', 'children': [child], 'translation': [width * .12, 0, depth * .08]})
    return model.bytes()


def hardware_glb(seed, shape):
    rng, model = random.Random(seed), GLB()
    dimensions = [rng.uniform(.65, 1.35), rng.uniform(.8, 2.2), rng.uniform(.65, 1.35)]
    vertices = box(*dimensions)
    if shape == 'wedge-open':
        vertices[2][1] *= .28; vertices[3][1] *= .28
    mesh = model.mesh(vertices, BOX_FACES[:-2] if shape == 'wedge-open' else BOX_FACES,
                      indexed=shape != 'wedge-open', skin=shape == 'skinned', open_surface=shape == 'wedge-open')
    if shape == 'nested-shared':
        children = [model.node({'mesh': mesh, 'translation': [sign * .55, 0, 0],
                                'scale': [sign * .7, 1.25 if sign > 0 else .7, .9]}, root=False) for sign in (-1, 1)]
        model.node({'name': 'shared geometry children', 'children': children,
                    'rotation': [0, math.sin(.23), 0, math.cos(.23)]})
    elif shape == 'skinned':
        joint = model.node({'name': 'single joint'})
        inverse = model.accessor([[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]], 16)
        model.document['skins'] = [{'joints': [joint], 'skeleton': joint, 'inverseBindMatrices': inverse}]
        model.node({'mesh': mesh, 'skin': 0})
    else:
        model.node({'mesh': mesh})
    return model.bytes()


def inspect_glb(data):
    """Validate container/buffer integrity without a renderer; return its glTF JSON."""
    if len(data) < 28 or struct.unpack_from('<III', data) != (0x46546C67, 2, len(data)):
        raise ValueError('Invalid GLB header')
    size, kind = struct.unpack_from('<II', data, 12)
    if kind != 0x4E4F534A or size % 4:
        raise ValueError('Invalid JSON chunk')
    document = json.loads(data[20:20 + size])
    offset = 20 + size
    binary_size, binary_kind = struct.unpack_from('<II', data, offset)
    if binary_kind != 0x004E4942 or offset + 8 + binary_size != len(data) or binary_size % 4:
        raise ValueError('Invalid binary chunk')
    length = document['buffers'][0]['byteLength']
    if not length <= binary_size < length + 4 or any('uri' in item for item in document['buffers']):
        raise ValueError('Fixture must be self-contained')
    for view in document['bufferViews']:
        if view.get('byteOffset', 0) + view['byteLength'] > length:
            raise ValueError('Buffer view exceeds binary chunk')
    return document
