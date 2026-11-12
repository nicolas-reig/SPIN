/** Test-only, separate memory runs. No strong references to MapView or its resources. */
export function geometryInventory(root) {
  const geometries=new Set(),materials=new Set(),buffers=new Set();
  let objects=0,meshes=0,skinnedMeshes=0,arrayBytes=0;
  root?.traverse(object=>{
    objects++;
    if(!object.isMesh && !object.isLine && !object.isPoints)return;
    if(object.isMesh)meshes++;
    if(object.isSkinnedMesh)skinnedMeshes++;
    if(object.geometry)geometries.add(object.geometry);
    for(const material of Array.isArray(object.material)?object.material:[object.material])if(material)materials.add(material);
  });
  const add=attribute=>{
    const buffer=(attribute?.array||attribute?.data?.array)?.buffer;
    if(buffer && !buffers.has(buffer)){buffers.add(buffer);arrayBytes+=buffer.byteLength;}
  };
  for(const geometry of geometries){
    add(geometry.index);
    for(const attribute of Object.values(geometry.attributes||{}))add(attribute);
    for(const attributes of Object.values(geometry.morphAttributes||{}))for(const attribute of attributes)add(attribute);
  }
  return {objects,meshes,skinned_meshes:skinnedMeshes,unique_geometries:geometries.size,
    unique_materials:materials.size,geometry_array_buffer_bytes:arrayBytes};
}

export function installMapProfiler(MapView,target=globalThis) {
  if(target.__visualMemory)throw Error('Memory profiler already installed');
  let current;
  const counts={init_calls:0,set_data_calls:0,pending_set_data:0,max_pending_set_data:0,
    superseded_completions:0,model_calls:0,clear_scene_calls:0,destroy_calls:0};
  for(const name of ['init','model','clearScene','destroy']){
    const original=MapView.prototype[name];
    if(typeof original!=='function')throw Error('Cannot instrument MapView.'+name);
    MapView.prototype[name]=function(...args){
      if(name==='init'){current=new WeakRef(this);counts.init_calls++;}
      else if(name==='model')counts.model_calls++;
      else if(name==='clearScene')counts.clear_scene_calls++;
      else counts.destroy_calls++;
      return Reflect.apply(original,this,args);
    };
  }
  const original=MapView.prototype.setData;
  MapView.prototype.setData=function(...args){
    counts.set_data_calls++;counts.pending_set_data++;
    counts.max_pending_set_data=Math.max(counts.max_pending_set_data,counts.pending_set_data);
    let result;
    try{result=Reflect.apply(original,this,args);}catch(error){counts.pending_set_data--;throw error;}
    const generation=this.generation;
    return Promise.resolve(result).finally(()=>{
      counts.pending_set_data--;
      if(generation!==this.generation)counts.superseded_completions++;
    });
  };
  target.__visualMemory={
    snapshot(){
      const map=current?.deref();
      return {counts:{...counts},map:map?{generation:map.generation,floor_id:map.floor?.id||null,
        root:geometryInventory(map.root),scene:geometryInventory(map.scene),
        renderer_memory:map.renderer?.info?.memory?{...map.renderer.info.memory}:null,
        renderer_render:map.renderer?.info?.render?{...map.renderer.info.render}:null,
        renderer_calls:map.renderer?.info?.calls??null}:null};
    },
    destroy(){const map=current?.deref();if(!map)throw Error('No live MapView');map.destroy();}
  };
  return target.__visualMemory;
}
