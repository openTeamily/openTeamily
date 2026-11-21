"""Pure unit tests for deterministic Discover ranking. No database or server."""
import unittest

from openteamily import ranking


class WorkRankingTests(unittest.TestCase):
    NOW = 1800000000

    def work(self, item_id, author='alice', created=None, **metrics):
        item = {
            'id': item_id,
            'title': item_id.upper(),
            'author_id': author,
            'created': self.NOW if created is None else created,
        }
        item.update(metrics)
        return item

    def ids(self, ranked):
        return [item['id'] for item in ranked]

    def by_id(self, ranked):
        return {item['id']: item for item in ranked}

    def test_determinism_and_input_order_do_not_change_results(self):
        items = [
            self.work('w2', 'alice', self.NOW - 100, likes=3),
            self.work('w1', 'bob', self.NOW - 50, collects=1),
            self.work('w3', 'carol', self.NOW - 200, comments=2),
        ]
        first = ranking.rank_works(items, self.NOW)
        second = ranking.rank_works(items, self.NOW)
        reversed_input = ranking.rank_works(list(reversed(items)), self.NOW)
        self.assertEqual(self.ids(first), self.ids(second))
        self.assertEqual(self.ids(first), self.ids(reversed_input))
        self.assertEqual([x['score'] for x in first], [x['score'] for x in second])
        self.assertNotIn('score', items[0])
        self.assertNotIn('reasons', items[0])

    def test_recency_decay_favors_newer_items_and_clamps_future(self):
        half_life = ranking.DEFAULT_RECENCY_HALF_LIFE
        old = self.work('old', 'alice', self.NOW - 10 * half_life)
        new = self.work('new', 'bob', self.NOW)
        future = self.work('future', 'carol', self.NOW + 3600)
        ranked = ranking.rank_works([old, new, future], self.NOW, weights={'author_cap': 5})
        rows = self.by_id(ranked)
        self.assertLess(rows['old']['reasons']['recency'], rows['new']['reasons']['recency'])
        self.assertAlmostEqual(rows['new']['reasons']['recency'], 1.0)
        self.assertAlmostEqual(rows['future']['reasons']['recency'], 1.0)
        self.assertEqual(self.ids(ranked)[-1], 'old')

    def test_engagement_counts_raise_the_score(self):
        low = self.work('low', 'alice')
        liked = self.work('liked', 'bob', likes=10)
        rich = self.work('rich', 'carol', likes=1, collects=2, comments=1)
        ranked = ranking.rank_works([low, liked, rich], self.NOW, weights={'author_cap': 5})
        rows = self.by_id(ranked)
        self.assertGreater(rows['liked']['reasons']['engagement'], 0.0)
        self.assertGreater(rows['rich']['reasons']['engagement'], 0.0)
        self.assertGreater(rows['liked']['score'], rows['low']['score'])
        self.assertGreater(rows['rich']['score'], rows['low']['score'])
        self.assertEqual(rows['low']['reasons']['engagement'], 0.0)

    def test_following_authors_add_a_follow_component(self):
        alice = self.work('w-alice', 'alice', likes=2)
        bob = self.work('w-bob', 'bob', likes=2)
        baseline = self.by_id(ranking.rank_works(
            [alice, bob], self.NOW, weights={'author_cap': 5}))
        followed = self.by_id(ranking.rank_works(
            [alice, bob], self.NOW, weights={'author_cap': 5},
            following_authors={'alice'}))
        self.assertEqual(baseline['w-alice']['reasons']['follow'], 0.0)
        self.assertEqual(followed['w-alice']['reasons']['follow'], 1.0)
        self.assertAlmostEqual(
            followed['w-alice']['score'] - baseline['w-alice']['score'], 1.0)
        self.assertEqual(followed['w-bob']['reasons']['follow'], 0.0)
        as_string = ranking.rank_works(
            [alice, bob], self.NOW, weights={'author_cap': 5},
            following_authors='alice')
        self.assertEqual(self.by_id(as_string)['w-alice']['reasons']['follow'], 1.0)

    def test_seen_items_are_demoted_but_never_excluded(self):
        seen = self.work('seen', 'alice', likes=1)
        fresh = self.work('fresh', 'bob', likes=1)
        baseline = self.by_id(ranking.rank_works(
            [seen, fresh], self.NOW, weights={'author_cap': 5}))
        demoted = self.by_id(ranking.rank_works(
            [seen, fresh], self.NOW, weights={'author_cap': 5, 'seen_penalty': 0.5},
            seen_ids={'seen'}))
        self.assertIn('seen', demoted)
        self.assertEqual(demoted['seen']['reasons']['seen_penalty'], 0.5)
        self.assertEqual(demoted['fresh']['reasons']['seen_penalty'], 1.0)
        self.assertAlmostEqual(demoted['seen']['score'], baseline['seen']['score'] * 0.5)
        zeroed = self.by_id(ranking.rank_works(
            [seen, fresh], self.NOW, weights={'author_cap': 5, 'seen_penalty': 0.0},
            seen_ids={'seen'}))
        self.assertIn('seen', zeroed)
        self.assertEqual(zeroed['seen']['score'], 0.0)

    def test_author_diversity_cap_is_enforced_in_the_top_list(self):
        items = [self.work('a%d' % index, 'alice', self.NOW - index) for index in range(4)]
        items.append(self.work('b1', 'bob', self.NOW - 100))
        items.append(self.work('c1', 'carol', self.NOW - 200))
        ranked = ranking.rank_works(items, self.NOW, weights={'author_cap': 1}, limit=3)
        self.assertEqual(len(ranked), 3)
        authors = [item['author_id'] for item in ranked]
        self.assertEqual(sorted(set(authors)), ['alice', 'bob', 'carol'])
        self.assertEqual(authors.count('alice'), 1)

        capped = ranking.rank_works(items, self.NOW, weights={'author_cap': 2}, limit=3)
        self.assertEqual([item['author_id'] for item in capped].count('alice'), 2)

        only_alice = ranking.rank_works(
            items[:4], self.NOW, weights={'author_cap': 1}, limit=3)
        self.assertEqual(len(only_alice), 1)
        self.assertEqual(only_alice[0]['author_id'], 'alice')

    def test_tie_break_uses_created_descending_then_id_ascending(self):
        equal = [
            self.work('b', 'bob'),
            self.work('a', 'alice'),
            self.work('c', 'carol'),
        ]
        self.assertEqual(
            self.ids(ranking.rank_works(equal, self.NOW, weights={'author_cap': 5})),
            ['a', 'b', 'c'])
        zero_weights = {'recency': 0.0, 'engagement': 0.0, 'follow': 0.0,
                        'seen_penalty': 1.0, 'author_cap': 5}
        items = [
            self.work('old', 'alice', self.NOW - 10),
            self.work('new', 'bob', self.NOW),
            self.work('a', 'carol', self.NOW),
            self.work('b', 'dave', self.NOW),
        ]
        self.assertEqual(
            self.ids(ranking.rank_works(items, self.NOW, weights=zero_weights)),
            ['a', 'b', 'new', 'old'])

    def test_missing_or_empty_metrics_count_as_zero(self):
        implicit = self.work('implicit', 'alice')
        explicit = self.work('explicit', 'bob', likes=0, collects=0, comments=0)
        nulls = self.work('nulls', 'carol', likes=None, collects=None, comments=None)
        no_title = self.work('no-title', 'dave', likes=0)
        no_title.pop('title')
        ranked = ranking.rank_works(
            [implicit, explicit, nulls, no_title], self.NOW, weights={'author_cap': 5})
        rows = self.by_id(ranked)
        for item_id in ('implicit', 'explicit', 'nulls', 'no-title'):
            self.assertEqual(rows[item_id]['reasons']['engagement'], 0.0)
            self.assertAlmostEqual(rows[item_id]['score'], rows['implicit']['score'])

    def test_empty_input_is_accepted(self):
        self.assertEqual(ranking.rank_works([], self.NOW), [])
        self.assertEqual(ranking.rank_works(None, self.NOW), [])
        self.assertEqual(ranking.rank_agents([], self.NOW), [])
        self.assertEqual(ranking.rank_agents(None, self.NOW), [])

    def test_limit_is_bounded_and_output_size_is_bounded(self):
        items = [self.work('w%03d' % index, 'author%03d' % index) for index in range(150)]
        self.assertEqual(len(ranking.rank_works(items, self.NOW)), 50)
        self.assertEqual(len(ranking.rank_works(items, self.NOW, limit=100)), 100)

    def test_invalid_weights_and_limits_are_rejected(self):
        items = [self.work('w')]
        bad_weights = [
            {'unknown': 1.0},
            {'recency': -0.1},
            {'recency': float('nan')},
            {'recency': float('inf')},
            {'follow': True},
            {'follow': 10001.0},
            {'seen_penalty': 1.5},
            {'author_cap': 0},
            {'author_cap': 2.5},
            [],
        ]
        for weights in bad_weights:
            with self.assertRaises(ValueError, msg=repr(weights)):
                ranking.rank_works(items, self.NOW, weights=weights)
        for limit in (0, -1, 101, '5', True, None):
            with self.assertRaises(ValueError, msg=repr(limit)):
                ranking.rank_works(items, self.NOW, limit=limit)
        with self.assertRaises(ValueError):
            ranking.rank_works(items, 'now')

    def test_invalid_item_shapes_are_rejected(self):
        bad_items = [
            [{'id': 'w', 'author_id': 'alice'}],
            [{'id': 'w', 'created': self.NOW}],
            [{'author_id': 'alice', 'created': self.NOW}],
            [{'id': '', 'author_id': 'alice', 'created': self.NOW}],
            [{'id': 'w', 'author_id': '', 'created': self.NOW}],
            [{'id': 'w', 'author_id': 'alice', 'created': 'now'}],
            ['not-a-mapping'],
            [{'id': 'w', 'author_id': 'alice', 'created': True}],
            [self.work('w'), self.work('w', 'bob')],
        ]
        for items in bad_items:
            with self.assertRaises(ValueError, msg=repr(items)):
                ranking.rank_works(items, self.NOW)

    def test_explain_components_are_consistent_with_the_score(self):
        items = [
            self.work('w1', 'alice', likes=2),
            self.work('w2', 'bob', self.NOW - 500, collects=1),
            self.work('w3', 'carol', comments=3),
        ]
        ranked = ranking.rank_works(
            items, self.NOW, following_authors={'alice'}, seen_ids={'w2'},
            weights={'author_cap': 5, 'seen_penalty': 0.5})
        for item in ranked:
            explained = ranking.explain(item)
            self.assertEqual(explained, item['reasons'])
            self.assertAlmostEqual(
                explained['recency'] + explained['engagement'] + explained['follow'],
                explained['base'])
            self.assertAlmostEqual(
                explained['base'] * explained['seen_penalty'], explained['score'])
            self.assertAlmostEqual(explained['score'], item['score'])
        with self.assertRaises(ValueError):
            ranking.explain({'id': 'w'})
        with self.assertRaises(ValueError):
            ranking.explain(None)

    def test_paginate_cursor_round_trip_and_validation(self):
        items = [self.work('w%d' % index, 'author%d' % index) for index in range(5)]
        ranked = ranking.rank_works(items, self.NOW, weights={'author_cap': 5}, limit=5)
        first = ranking.paginate(ranked, None, 2)
        self.assertEqual(self.ids(first['items']), self.ids(ranked[:2]))
        self.assertIsNone(first['cursor'])
        self.assertIsInstance(first['next_cursor'], str)
        self.assertNotEqual(first['next_cursor'], '2')
        second = ranking.paginate(ranked, first['next_cursor'], 2)
        self.assertEqual(second['cursor'], first['next_cursor'])
        self.assertEqual(self.ids(second['items']), self.ids(ranked[2:4]))
        third = ranking.paginate(ranked, second['next_cursor'], 2)
        self.assertEqual(self.ids(third['items']), self.ids(ranked[4:]))
        self.assertIsNone(third['next_cursor'])
        combined = first['items'] + second['items'] + third['items']
        self.assertEqual(self.ids(combined), self.ids(ranked))
        self.assertEqual(ranking.paginate(ranked, '', 2)['items'], first['items'])
        self.assertEqual(ranking.paginate([], None, 10),
                         {'items': [], 'next_cursor': None, 'cursor': None})
        for cursor in ('not-a-cursor', '!!!!', '2', 123):
            with self.assertRaises(ValueError, msg=repr(cursor)):
                ranking.paginate(ranked, cursor, 2)
        for limit in (0, -1, 101, '2', True, None):
            with self.assertRaises(ValueError, msg=repr(limit)):
                ranking.paginate(ranked, None, limit)
        self.assertEqual(ranked[0]['id'], first['items'][0]['id'])


class AgentRankingTests(unittest.TestCase):
    NOW = 1800000000

    def agent(self, item_id, creator='alice', created=None, **metrics):
        item = {
            'id': item_id,
            'name': item_id.upper(),
            'creator_id': creator,
            'created': self.NOW if created is None else created,
        }
        item.update(metrics)
        return item

    def ids(self, ranked):
        return [item['id'] for item in ranked]

    def by_id(self, ranked):
        return {item['id']: item for item in ranked}

    def test_agent_signals_determinism_and_seen_demotion(self):
        half_life = ranking.DEFAULT_RECENCY_HALF_LIFE
        items = [
            self.agent('old', 'alice', self.NOW - 10 * half_life, likes=1),
            self.agent('new', 'bob', self.NOW, likes=1),
            self.agent('popular', 'carol', self.NOW, likes=3, installs=100, uses=5),
            self.agent('followed', 'dave', self.NOW, likes=1),
        ]
        ranked = ranking.rank_agents(
            items, self.NOW, following_creators={'dave'}, seen_ids={'old'},
            weights={'author_cap': 5, 'seen_penalty': 0.25})
        self.assertEqual(self.ids(ranked)[0], 'popular')
        rows = self.by_id(ranked)
        self.assertGreater(rows['followed']['score'], rows['new']['score'])
        self.assertGreater(rows['new']['score'], rows['old']['score'])
        self.assertEqual(rows['followed']['reasons']['follow'], 1.0)
        self.assertEqual(rows['old']['reasons']['seen_penalty'], 0.25)
        self.assertEqual(rows['popular']['reasons']['engagement_value'] > 0, True)
        reversed_ranked = ranking.rank_agents(
            list(reversed(items)), self.NOW, following_creators={'dave'}, seen_ids={'old'},
            weights={'author_cap': 5, 'seen_penalty': 0.25})
        self.assertEqual(self.ids(ranked), self.ids(reversed_ranked))
        self.assertEqual([item['score'] for item in ranked],
                         [item['score'] for item in reversed_ranked])

    def test_agent_creator_diversity_cap(self):
        items = [self.agent('a%d' % index, 'alice', self.NOW - index) for index in range(3)]
        items.append(self.agent('b1', 'bob', self.NOW - 100))
        ranked = ranking.rank_agents(items, self.NOW, weights={'author_cap': 1}, limit=2)
        self.assertEqual([item['creator_id'] for item in ranked], ['alice', 'bob'])

    def test_agent_author_fallback_missing_metrics_and_validation(self):
        item = {'id': 'a', 'name': 'A', 'author_id': 'alice', 'created': self.NOW}
        self.assertEqual(self.ids(ranking.rank_agents([item], self.NOW)), ['a'])
        implicit = self.agent('implicit', 'alice')
        explicit = self.agent('explicit', 'bob', likes=0, installs=0, uses=0)
        rows = self.by_id(ranking.rank_agents(
            [implicit, explicit], self.NOW, weights={'author_cap': 5}))
        self.assertAlmostEqual(rows['implicit']['score'], rows['explicit']['score'])
        with self.assertRaises(ValueError):
            ranking.rank_agents([{'id': 'a', 'created': self.NOW}], self.NOW)
        with self.assertRaises(ValueError):
            ranking.rank_agents([self.agent('a'), self.agent('a', 'bob')], self.NOW)
        with self.assertRaises(ValueError):
            ranking.rank_agents([self.agent('a')], self.NOW, weights={'installs': -1})
        with self.assertRaises(ValueError):
            ranking.rank_agents([self.agent('a')], self.NOW, limit=0)


if __name__ == '__main__':
    unittest.main()
