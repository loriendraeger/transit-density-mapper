"""OSM -> raw.osm_edges / raw.osm_nodes / raw.osm_pois, with pyosmium.

Why not ogr2ogr (as for other sources)? GDAL's OSM driver drops node IDs, and the walk
network needs them: two ways are connected only where they share a node (a bridge over
a street shares none), and crossing/signal tags live on nodes.

- osm_edges: every walkable or barrier highway way, split into edges at graph nodes
  (nodes shared by two or more of these ways, way ends, and crossing/signal nodes).
- osm_nodes: graph nodes plus every crossing / traffic-signal node, with their tags.
- osm_pois: anything tagged with a key from config/poi_categories.csv, as a point
  (nodes) or a polygon (closed ways and multipolygon relations).
- osm_buildings: every building with its type and levels: residential ones estimate
  dwelling units where parcels don't have a count (10_staging/40_osm.sql), the rest
  place college enrollment on campus buildings (40_generators/35_schools.sql).
"""

import csv
import io
import json
import subprocess
from collections import Counter

import osmium
import psycopg

from . import config

# Tags worth keeping on network ways and nodes (the rest is noise for routing).
WAY_TAGS = {
    "highway",
    "footway",
    "crossing",
    "crossing:markings",
    "crossing:signals",
    "oneway",
    "name",
    "sidewalk",
    "foot",
    "access",
    "lanes",
    "bridge",
    "tunnel",
    "service",
    "area",
    "indoor",
    "level",
    "layer",
    "junction",
    "ref",
}
NODE_TAGS = {
    "highway",
    "crossing",
    "crossing:markings",
    "crossing:signals",
    "crossing_ref",
    "traffic_signals",
    "traffic_signals:direction",
    "button_operated",
    "public_transport",
    "bus",
    "name",
}
SIGNAL_NODES = {"traffic_signals", "crossing"}
NO_ACCESS = {"no", "private"}
FOOT_OK = {"yes", "designated", "permissive", "destination"}


def road_classes() -> dict[str, dict]:
    with open(config.CONFIG / "road_classes.csv") as f:
        return {r["highway"]: r for r in csv.DictReader(f)}


def poi_keys() -> set[str]:
    with open(config.CONFIG / "poi_categories.csv") as f:
        return {r["key"] for r in csv.DictReader(f)}


def walkable(tags: dict, classes: dict) -> bool:
    hw = tags.get("highway")
    cls = classes.get(hw)
    if cls is None or cls["walkable"] != "true":
        return False
    if tags.get("area") == "yes" or tags.get("indoor") == "yes":
        return False
    foot = tags.get("foot")
    if foot == "no":
        return False
    if tags.get("access") in NO_ACCESS and foot not in FOOT_OK:
        return False
    return True


class Collector(osmium.SimpleHandler):
    def __init__(self, classes: dict, poi_keys: set[str]):
        super().__init__()
        self.classes = classes
        self.poi_keys = poi_keys
        self.ways: list[tuple[int, dict, list[tuple[int, float, float]]]] = []
        self.tagged_nodes: dict[int, tuple[dict, float, float]] = {}
        self.pois: list[tuple[str, int, dict, bytes]] = []
        self.buildings: list[tuple[str, str | None, bytes]] = []
        self.wkb = osmium.geom.WKBFactory()

    def _poi_tags(self, tags) -> dict | None:
        if not any(k in tags for k in self.poi_keys):
            return None
        return {t.k: t.v for t in tags}

    def node(self, n):
        tags = n.tags
        if tags.get("highway") in SIGNAL_NODES or "crossing" in tags:
            self.tagged_nodes[n.id] = (
                {k: v for k, v in ((t.k, t.v) for t in tags) if k in NODE_TAGS},
                n.location.lon,
                n.location.lat,
            )
        poi = self._poi_tags(tags)
        if poi is not None:
            self.pois.append(("n", n.id, poi, bytes.fromhex(self.wkb.create_point(n))))

    def way(self, w):
        hw = w.tags.get("highway")
        if hw is None:
            return
        tags = {t.k: t.v for t in w.tags if t.k in WAY_TAGS}
        if not walkable(tags, self.classes):
            return
        try:
            nodes = [(n.ref, n.lon, n.lat) for n in w.nodes]
        except osmium.InvalidLocationError:
            return  # way leaves the extract
        if len(nodes) >= 2:
            self.ways.append((w.id, tags, nodes))

    def area(self, a):
        building = a.tags.get("building")
        if building and building != "no":
            try:
                geom = bytes.fromhex(self.wkb.create_multipolygon(a))
                self.buildings.append((building, a.tags.get("building:levels"), geom))
            except RuntimeError:
                pass
        poi = self._poi_tags(a.tags)
        if poi is None:
            return
        try:
            geom = bytes.fromhex(self.wkb.create_multipolygon(a))
        except RuntimeError:
            return
        kind = "w" if a.from_way() else "r"
        self.pois.append((kind, a.orig_id(), poi, geom))


def _linestring_wkt(pts: list[tuple[int, float, float]]) -> str:
    return "LINESTRING(" + ",".join(f"{lon:.7f} {lat:.7f}" for _, lon, lat in pts) + ")"


def extract_area(pbf) -> str:
    out = config.BUILD / "osm" / "area.osm.pbf"
    out.parent.mkdir(parents=True, exist_ok=True)
    bbox = ",".join(map(str, config.pipeline()["study_area"]["bbox_4326"]))
    cmd = ["osmium", "extract", "--bbox", bbox, "--overwrite", "-o", str(out), str(pbf)]
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)
    return str(out)


def load_osm(pbf) -> None:
    area = extract_area(pbf)
    h = Collector(road_classes(), poi_keys())
    # locations=True keeps node coordinates for ways; the `area` callback makes pyosmium
    # assemble (multi)polygons from closed ways and relations.
    h.apply_file(area, locations=True)
    print(f"ways {len(h.ways)}, tagged nodes {len(h.tagged_nodes)}, pois {len(h.pois)}")

    # Graph nodes: shared by 2+ ways, way ends, and tagged crossing/signal nodes.
    use = Counter(ref for _, _, nodes in h.ways for ref, _, _ in nodes)
    node_xy: dict[int, tuple[float, float]] = {}
    edges = io.StringIO()
    n_edges = 0
    for way_id, tags, nodes in h.ways:
        start = 0
        seq = 0
        for i in range(1, len(nodes)):
            ref = nodes[i][0]
            if i == len(nodes) - 1 or use[ref] > 1 or ref in h.tagged_nodes:
                piece = nodes[start : i + 1]
                a, b = piece[0], piece[-1]
                node_xy[a[0]] = (a[1], a[2])
                node_xy[b[0]] = (b[1], b[2])
                edges.write(
                    f"{way_id}\t{seq}\t{a[0]}\t{b[0]}\t{json.dumps(tags)}\t"
                    f"SRID=4326;{_linestring_wkt(piece)}\n"
                )
                seq += 1
                n_edges += 1
                start = i
    nodes_buf = io.StringIO()
    for ref, (lon, lat) in node_xy.items():
        tags = h.tagged_nodes.get(ref, ({},))[0]
        nodes_buf.write(f"{ref}\t{json.dumps(tags)}\tSRID=4326;POINT({lon:.7f} {lat:.7f})\n")
    for ref, (tags, lon, lat) in h.tagged_nodes.items():
        if ref not in node_xy:
            nodes_buf.write(f"{ref}\t{json.dumps(tags)}\tSRID=4326;POINT({lon:.7f} {lat:.7f})\n")

    with psycopg.connect("") as conn:
        conn.execute("CREATE SCHEMA IF NOT EXISTS raw")
        conn.execute(
            """
            DROP TABLE IF EXISTS raw.osm_edges, raw.osm_nodes, raw.osm_pois, raw.osm_buildings;
            CREATE TABLE raw.osm_buildings (building text, levels text, geom geometry);
            CREATE TABLE raw.osm_edges (
                way_id bigint, seq int, source bigint, target bigint, tags jsonb,
                geom geometry(LineString, 4326));
            CREATE TABLE raw.osm_nodes (id bigint, tags jsonb, geom geometry(Point, 4326));
            CREATE TABLE raw.osm_pois (osm_type text, osm_id bigint, tags jsonb, geom geometry);
            """
        )
        with conn.cursor() as cur:
            with cur.copy("COPY raw.osm_edges FROM STDIN") as cp:
                cp.write(edges.getvalue())
            with cur.copy("COPY raw.osm_nodes FROM STDIN") as cp:
                cp.write(nodes_buf.getvalue())
            with cur.copy("COPY raw.osm_pois (osm_type, osm_id, tags, geom) FROM STDIN") as cp:
                for kind, oid, tags, wkb in h.pois:
                    cp.write_row((kind, oid, json.dumps(tags), wkb.hex()))
            with cur.copy("COPY raw.osm_buildings FROM STDIN") as cp:
                for building, levels, wkb in h.buildings:
                    cp.write_row((building, levels, wkb.hex()))
        # WKB carries no SRID; set it and type the column in one rewrite.
        for table in ("osm_pois", "osm_buildings"):
            conn.execute(
                f"ALTER TABLE raw.{table} ALTER geom TYPE geometry(Geometry, 4326) "
                "USING ST_SetSRID(geom, 4326)"
            )
        conn.execute("ANALYZE raw.osm_edges; ANALYZE raw.osm_nodes; ANALYZE raw.osm_pois")
    print(
        f"loaded {n_edges} edges, {len(node_xy)} graph nodes, {len(h.pois)} pois, "
        f"{len(h.buildings)} buildings"
    )
