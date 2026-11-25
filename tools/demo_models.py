"""Generate original sample geometry for the public configurator."""

import json
import math
import struct


QUAD_INDICES = (0, 2, 1, 0, 3, 2)
QUAD_UV = (0, 0, 1, 0, 1, 1, 0, 1)


class DemoScene:
    def __init__(self):
        self.binary = bytearray()
        self.document = {
            "asset": {"version": "2.0"},
            "scene": 0,
            "scenes": [{"nodes": []}],
            "nodes": [],
            "meshes": [],
            "bufferViews": [],
            "accessors": [],
        }

    def accessor(self, values, component_type, shape, count, bounds=()):
        self.binary.extend(b"\0" * (-len(self.binary) % 4))
        offset = len(self.binary)
        component_format = {5123: "H", 5126: "f"}[component_type]
        self.binary.extend(struct.pack(f"<{len(values)}{component_format}", *values))
        views = self.document["bufferViews"]
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(self.binary) - offset})
        accessors = self.document["accessors"]
        accessor = {
            "bufferView": len(views) - 1,
            "componentType": component_type,
            "count": count,
            "type": shape,
        }
        if bounds:
            accessor["min"], accessor["max"] = bounds
        accessors.append(accessor)
        return len(accessors) - 1

    def mesh(self, vertices, indices, extras, guide=False):
        axes = list(zip(*vertices))
        positions = [value for point in vertices for value in point]
        position = self.accessor(positions, 5126, "VEC3", len(vertices), (
            [min(axis) for axis in axes], [max(axis) for axis in axes],
        ))
        attributes = {"POSITION": position}
        if guide:
            attributes["TEXCOORD_0"] = self.accessor(QUAD_UV, 5126, "VEC2", len(vertices))
        index = self.accessor(indices, 5123, "SCALAR", len(indices))
        meshes = self.document["meshes"]
        meshes.append({"primitives": [{"attributes": attributes, "indices": index}]})
        nodes = self.document["nodes"]
        self.document["scenes"][0]["nodes"].append(len(nodes))
        nodes.append({"mesh": len(meshes) - 1, "extras": extras})

    def paper(self, pose, panel, vertices, *, tone=1, inward=False):
        indices = (0, 1, 2, 0, 2, 3) if inward else QUAD_INDICES
        self.mesh(vertices, indices, {"pose": pose, "role": "paper", "surfaceId": panel, "tone": tone})

    def guide(self, pose, panel, vertices):
        self.mesh(vertices, QUAD_INDICES, {
            "pose": pose,
            "role": "print",
            "panelId": panel,
            "widthMm": round(1000 * math.dist(vertices[0], vertices[1])),
            "heightMm": round(1000 * math.dist(vertices[1], vertices[2])),
        }, guide=True)

    def encode(self):
        self.document["buffers"] = [{"byteLength": len(self.binary)}]
        document = json.dumps(self.document, separators=(",", ":")).encode()
        document += b" " * (-len(document) % 4)
        binary = self.binary + b"\0" * (-len(self.binary) % 4)
        return b"".join((
            struct.pack("<4sII", b"glTF", 2, 28 + len(document) + len(binary)),
            struct.pack("<I4s", len(document), b"JSON"),
            document,
            struct.pack("<I4s", len(binary), b"BIN\0"),
            binary,
        ))


def rectangular_faces(half_width, half_depth, bottom, top):
    left, right = -half_width, half_width
    rear, front = -half_depth, half_depth
    return {
        "front": ((left, top, front), (right, top, front), (right, bottom, front), (left, bottom, front)),
        "back": ((right, top, rear), (left, top, rear), (left, bottom, rear), (right, bottom, rear)),
        "right-side": ((right, top, front), (right, top, rear), (right, bottom, rear), (right, bottom, front)),
        "left-side": ((left, top, rear), (left, top, front), (left, bottom, front), (left, bottom, rear)),
        "base": ((left, bottom, front), (right, bottom, front), (right, bottom, rear), (left, bottom, rear)),
        "roof": ((left, top, rear), (right, top, rear), (right, top, front), (left, top, front)),
    }


def open_container(scene, pose, half_width, half_depth, height):
    outside = rectangular_faces(half_width, half_depth, 0, height)
    inside = rectangular_faces(half_width - .002, half_depth - .002, .002, height)
    for panel in ("front", "back", "right-side", "left-side", "base"):
        scene.paper(pose, panel, outside[panel])
        scene.paper(pose, "interior", inside[panel], tone=.87, inward=True)
        if panel in ("front", "back"):
            scene.guide(pose, panel, outside[panel])
        if panel != "base":
            outer_left, outer_right = outside[panel][:2]
            inner_left, inner_right = inside[panel][:2]
            scene.paper(pose, "interior", (inner_left, inner_right, outer_right, outer_left), tone=.92)


def carton(scene):
    angles = {"closed": 0, "open": math.radians(108)}
    hinge_y, hinge_z = .083, -.056
    lid = rectangular_faces(.092, .058, hinge_y, .105)
    underside = tuple((x, y - .003, z) for x, y, z in lid["roof"])
    for pose, angle in angles.items():
        open_container(scene, pose, .090, .056, hinge_y)
        sine, cosine = math.sin(angle), math.cos(angle)

        def turn(vertices):
            transformed = []
            for x, y, z in vertices:
                dy, dz = y - hinge_y, z - hinge_z
                transformed.append((x, hinge_y + dy * cosine + dz * sine, hinge_z - dy * sine + dz * cosine))
            return transformed

        for panel in ("front", "back", "right-side", "left-side", "roof"):
            surface = "closure" if panel == "front" else panel
            vertices = turn(lid[panel])
            scene.paper(pose, surface, vertices, tone=.96)
            if pose == "closed" and surface == "closure":
                scene.guide(pose, surface, vertices)
        scene.paper(pose, "interior", turn(underside), tone=.88, inward=True)


def ribbon(scene, z):
    points = []
    steps = 12
    for step in range(steps + 1):
        angle = math.pi * step / steps
        sine, cosine = math.sin(angle), math.cos(angle)
        points.extend((cosine * width, .189 + sine * height, z) for width, height in (
            (.062, .098), (.051, .087),
        ))
    indices = []
    for start in range(0, 2 * steps, 2):
        outer, inner, next_outer, next_inner = range(start, start + 4)
        first = (outer, inner, next_outer)
        second = (next_outer, inner, next_inner)
        indices.extend(first + second + first[::-1] + second[::-1])
    scene.mesh(points, indices, {"pose": "closed", "role": "ribbon"})


def handled_bag(scene):
    open_container(scene, "closed", .095, .052, .224)
    ribbon(scene, -.053)
    ribbon(scene, .053)


def demo_model(product):
    scene = DemoScene()
    {"box": carton, "bag": handled_bag}[product](scene)
    return scene.encode()
