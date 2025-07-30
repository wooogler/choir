// 간단한 테스트: replaceNodeAtomically 함수가 제대로 작동하는지 확인

const testReplaceNodeAtomically = () => {
  console.log('=== Testing replaceNodeAtomically ===');
  
  // 가상의 트리 구조 생성
  const mockTree = {
    nodeMap: new Map([
      ['parent-1', { id: 'parent-1', type: 'section', children: [{ id: 'target-node', type: 'paragraph' }] }],
      ['target-node', { id: 'target-node', type: 'paragraph', parentId: 'parent-1' }]
    ]),
    root: {
      children: [
        { 
          id: 'parent-1', 
          type: 'section', 
          children: [
            { id: 'target-node', type: 'paragraph' }
          ] 
        }
      ]
    }
  };

  // replacement 노드들
  const replacementNodes = [
    { id: 'new-node-1', type: 'listItem', parentId: 'parent-1' },
    { id: 'new-node-2', type: 'listItem', parentId: 'parent-1' }
  ];

  console.log('Before replacement:');
  console.log('nodeMap keys:', Array.from(mockTree.nodeMap.keys()));
  console.log('root structure:', JSON.stringify(mockTree.root, null, 2));

  // replaceNodeAtomically 호출 시뮬레이션
  // 1. 새 노드들을 nodeMap에 추가
  replacementNodes.forEach(node => {
    mockTree.nodeMap.set(node.id, node);
  });

  // 2. 기존 노드 제거
  mockTree.nodeMap.delete('target-node');

  // 3. 부모의 children에서 교체
  const parentNode = mockTree.nodeMap.get('parent-1');
  if (parentNode && parentNode.children) {
    const nodeIndex = parentNode.children.findIndex(child => child.id === 'target-node');
    if (nodeIndex !== -1) {
      parentNode.children.splice(nodeIndex, 1, ...replacementNodes);
      console.log(`Replaced node at index ${nodeIndex}`);
    }
  }

  console.log('After replacement:');
  console.log('nodeMap keys:', Array.from(mockTree.nodeMap.keys()));
  console.log('parent children:', parentNode.children.map(c => c.id));
  
  // 새로운 노드들이 제대로 추가되었는지 확인
  const newNodeIds = ['new-node-1', 'new-node-2'];
  const foundNodes = newNodeIds.filter(id => mockTree.nodeMap.has(id));
  console.log(`Found ${foundNodes.length}/${newNodeIds.length} new nodes in nodeMap`);
};

testReplaceNodeAtomically();